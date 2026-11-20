import { reservePoolRequest, STOCK_NOTIFY_CHANNEL, REQUEST_NOTIFY_CHANNEL } from './reservation.js';

// Reservation coordinator (lot P3). Serves the waiting requests:
//  - immediately when stock arrives (pg_notify windows_pool_stock, sent by the manager when a
//    VM becomes ready) or a request is created (windows_pool_requests);
//  - and periodically as a fallback (lost notification, connection cut, restart).
// Each attempt is a short transaction (reservePoolRequest): all or nothing, SKIP LOCKED,
// FIFO per template. Several replicas may run it at the same time.
// A waiting request holds nothing: neither a VM, nor a lock, nor a worker slot.

export function createReservationCoordinator({ db, log = console, onReserved = async () => {} }) {
  let running = null;
  let again = false;

  // Goes through the waiting requests oldest first (the FIFO order is also enforced on the SQL side).
  async function reconcileOnce() {
    const waiting = (await db.query(
      `SELECT id FROM windows_pool_requests WHERE status = 'waiting_for_pool' ORDER BY created_at, id`)).rows;
    const outcome = { reserved: [], waiting: [] };
    for (const { id } of waiting) {
      try {
        const result = await reservePoolRequest(db, id);
        if (result.status === 'reserved') {
          outcome.reserved.push(id);
          // The hook (e.g. promote the delayed BullMQ job) must never cancel the reservation.
          await Promise.resolve(onReserved({ requestId: id, vms: result.vms })).catch(error =>
            log.warn?.(`[windows-pool] onReserved ${id}: ${error.message}`));
        } else if (result.status === 'waiting') {
          outcome.waiting.push({ id, reason: result.reason, missing: result.missing });
        }
      } catch (error) {
        log.error?.(`[windows-pool] reservation ${id}: ${error.message}`);
      }
    }
    return outcome;
  }

  // Coalesces the wake-ups: a single pass at a time, plus one pass if something arrived meanwhile.
  function reconcile() {
    if (running) { again = true; return running; }
    running = (async () => {
      let last;
      do { again = false; last = await reconcileOnce(); } while (again);
      return last;
    })().finally(() => { running = null; });
    return running;
  }

  // Dedicated LISTEN connection. Returns stop(). A disconnection is not fatal:
  // the periodic reconciliation takes over, and the caller can call listen() again.
  async function listen({ onClose = () => {} } = {}) {
    const client = await db.connect();
    const onNotification = () => { reconcile().catch(() => undefined); };
    client.on('notification', onNotification);
    await client.query(`LISTEN ${STOCK_NOTIFY_CHANNEL}`);
    await client.query(`LISTEN ${REQUEST_NOTIFY_CHANNEL}`);
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      client.off('notification', onNotification);
      await client.query('UNLISTEN *').catch(() => undefined);
      client.release(true);
      onClose();
    };
    client.on('error', error => { log.warn?.(`[windows-pool] LISTEN interrupted: ${error.message}`); stop(); });
    return stop;
  }

  return { reconcile, listen, idle: () => running ?? Promise.resolve() };
}
