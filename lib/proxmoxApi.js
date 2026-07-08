import http from 'node:http';
import https from 'node:https';

const PROXMOX_TASK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const PROXMOX_TASK_WAIT_RETRY_MS = 2000;
const GUEST_AGENT_EXEC_TIMEOUT_MS = 60 * 1000;
const GUEST_AGENT_EXEC_RETRY_MS = 1500;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const buildHttpError = (statusCode, body) => {
  let proxmoxMessage = null;
  try {
    proxmoxMessage = JSON.parse(body)?.message ?? null;
  } catch {
    proxmoxMessage = null;
  }

  const detail = String(proxmoxMessage ?? body ?? '').trim();
  const error = new Error(`HTTP ${statusCode}${detail ? `: ${detail}` : ''}`);
  error.statusCode = statusCode;
  error.body = body;
  error.proxmoxMessage = proxmoxMessage;
  return error;
};

export const formatProxmoxError = error =>
  String(error?.proxmoxMessage ?? error?.message ?? error)
    .replace(/\s+/g, ' ')
    .trim();

export const isProxmoxVmMissingMessage = message =>
  /does not exist|no such file or directory|not found|non[ -]?existent/i.test(String(message ?? '').trim());

const encodeRequestBody = body => {
  if (body === null || body === undefined) {
    return null;
  }
  if (body instanceof URLSearchParams) {
    return {
      content: body.toString(),
      contentType: 'application/x-www-form-urlencoded'
    };
  }
  if (typeof body === 'string') {
    return { content: body, contentType: null };
  }
  return {
    content: new URLSearchParams(
      Object.entries(body)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => [key, String(value)])
    ).toString(),
    contentType: 'application/x-www-form-urlencoded'
  };
};

export const requestJson = ({
  url,
  method = 'GET',
  headers = {},
  rejectUnauthorized = true,
  body = null,
  timeoutMs = 30_000
}) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const requestBody = encodeRequestBody(body);
    const requestHeaders = { ...headers };
    if (requestBody?.contentType && !Object.keys(requestHeaders).some(header => header.toLowerCase() === 'content-type')) {
      requestHeaders['Content-Type'] = requestBody.contentType;
    }
    if (requestBody && !Object.keys(requestHeaders).some(header => header.toLowerCase() === 'content-length')) {
      requestHeaders['Content-Length'] = Buffer.byteLength(requestBody.content);
    }

    const request = transport.request(
      target,
      {
        method,
        headers: requestHeaders,
        rejectUnauthorized
      },
      response => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          responseBody += chunk;
        });
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(buildHttpError(response.statusCode, responseBody));
            return;
          }
          if (!responseBody.trim()) {
            resolve({});
            return;
          }
          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Timed out after ${timeoutMs}ms calling ${target.pathname}`));
    });
    if (requestBody) {
      request.write(requestBody.content);
    }
    request.end();
  });

export const proxmoxRequestOptions = envSettings => ({
  headers: {
    Authorization: `PVEAPIToken=${envSettings.proxmox_api_token_id}=${envSettings.proxmox_api_token_secret}`
  },
  rejectUnauthorized: !envSettings.proxmox_tls_insecure
});

export const proxmoxApiUrl = (envSettings, path) =>
  new URL(String(path).replace(/^\/+/, ''), `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`);

export const normalizeProxmoxNodeList = value => {
  const rawNodes = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(rawNodes.map(node => String(node).trim()).filter(Boolean))];
};

export const isProxmoxTemplate = value => value === true || value === 1 || String(value).trim() === '1';

export const fetchProxmoxNodeNames = async (envSettings, { onlineOnly = false } = {}) => {
  const payload = await requestJson({
    url: proxmoxApiUrl(envSettings, 'nodes'),
    method: 'GET',
    ...proxmoxRequestOptions(envSettings)
  });
  return (Array.isArray(payload?.data) ? payload.data : [])
    .filter(node => {
      const status = String(node?.status ?? '').trim().toLowerCase();
      return !onlineOnly || !status || status === 'online';
    })
    .map(node => String(node?.node ?? '').trim())
    .filter(Boolean);
};

export const resolveProxmoxTargetNodes = async envSettings => {
  const configuredNodes = normalizeProxmoxNodeList(envSettings.proxmox_nodes);
  if (configuredNodes.length) {
    return configuredNodes;
  }

  let discoveredNodes = [];
  try {
    discoveredNodes = await fetchProxmoxNodeNames(envSettings, { onlineOnly: true });
  } catch (error) {
    console.warn(
      `Unable to discover Proxmox nodes; falling back to PROXMOX_NODE (${formatProxmoxError(error)})`
    );
  }
  if (discoveredNodes.length) {
    const preferredNode = String(envSettings.proxmox_node ?? '').trim();
    return [
      ...new Set([
        ...(discoveredNodes.includes(preferredNode) ? [preferredNode] : []),
        ...discoveredNodes
      ])
    ];
  }

  return normalizeProxmoxNodeList(envSettings.proxmox_node);
};

export const fetchProxmoxVmResources = async envSettings => {
  const payload = await requestJson({
    url: proxmoxApiUrl(envSettings, 'cluster/resources?type=vm'),
    method: 'GET',
    ...proxmoxRequestOptions(envSettings)
  });
  return Array.isArray(payload?.data) ? payload.data : [];
};

export const fetchVmConfig = async (envSettings, node, vmid) => {
  const payload = await requestJson({
    url: proxmoxApiUrl(envSettings, `nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`),
    method: 'GET',
    ...proxmoxRequestOptions(envSettings)
  });
  return payload?.data ?? {};
};

export const fetchVmCurrentStatus = async (envSettings, node, vmid) => {
  const payload = await requestJson({
    url: proxmoxApiUrl(envSettings, `nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/current`),
    method: 'GET',
    ...proxmoxRequestOptions(envSettings)
  });
  return payload?.data ?? {};
};

export const fetchProxmoxTaskStatus = async (envSettings, node, upid) => {
  const payload = await requestJson({
    url: proxmoxApiUrl(envSettings, `nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`),
    method: 'GET',
    ...proxmoxRequestOptions(envSettings)
  });
  return payload?.data ?? {};
};

export const waitForProxmoxTask = async (
  envSettings,
  node,
  upid,
  { timeoutMs = PROXMOX_TASK_WAIT_TIMEOUT_MS } = {}
) => {
  const normalizedUpid = String(upid ?? '').trim();
  if (!normalizedUpid) {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await fetchProxmoxTaskStatus(envSettings, node, normalizedUpid);
    const state = String(status?.status ?? '').trim().toLowerCase();
    if (state === 'stopped') {
      const exitStatus = String(status?.exitstatus ?? '').trim();
      if (!exitStatus || exitStatus.toUpperCase() === 'OK') {
        return;
      }
      throw new Error(`Proxmox task ${normalizedUpid} failed with exit status ${exitStatus}`);
    }
    await sleep(PROXMOX_TASK_WAIT_RETRY_MS);
  }

  throw new Error(`Timed out waiting for Proxmox task ${normalizedUpid} on node ${node}`);
};

export const resolveProxmoxTaskNode = (upid, fallbackNode) => {
  const match = String(upid ?? '').match(/^UPID:([^:]+):/);
  return match?.[1] || fallbackNode;
};

export const resolveVmByDirectConfigLookup = async (envSettings, vmid) => {
  const failures = [];
  let discoveredNodes = [];
  try {
    discoveredNodes = await fetchProxmoxNodeNames(envSettings);
  } catch (error) {
    failures.push({ node: 'nodes', message: formatProxmoxError(error) });
  }
  const nodes = [
    String(envSettings.proxmox_node ?? '').trim(),
    ...normalizeProxmoxNodeList(envSettings.proxmox_nodes),
    ...discoveredNodes
  ].filter(Boolean);
  const uniqueNodes = [...new Set(nodes)];

  for (const node of uniqueNodes) {
    try {
      const config = await fetchVmConfig(envSettings, node, vmid);
      const name = String(config?.name ?? '').trim();
      if (!name) {
        failures.push({ node, message: 'VM config was found but did not include a name' });
        continue;
      }
      return {
        match: {
          vmid: Number(vmid),
          name,
          node,
          template: isProxmoxTemplate(config?.template)
        },
        failures
      };
    } catch (error) {
      failures.push({ node, message: formatProxmoxError(error) });
    }
  }

  return { match: null, failures };
};

export const resolveVmNodesByVmid = async (envSettings, vmids, { allowMissing = false } = {}) => {
  const requestedVmids = [
    ...new Set((Array.isArray(vmids) ? vmids : []).map(vmid => Number(vmid)).filter(vmid => Number.isInteger(vmid) && vmid > 0))
  ];
  const nodeByVmid = new Map();
  let resourceLookupError = null;
  let resources = [];

  try {
    resources = await fetchProxmoxVmResources(envSettings);
  } catch (error) {
    resourceLookupError = formatProxmoxError(error);
  }

  for (const vmid of requestedVmids) {
    const match = resources.find(resource => Number(resource.vmid) === vmid);
    const node = String(match?.node ?? '').trim();
    if (node) {
      nodeByVmid.set(vmid, node);
    }
  }

  for (const vmid of requestedVmids.filter(vmid => !nodeByVmid.has(vmid))) {
    const { match, failures } = await resolveVmByDirectConfigLookup(envSettings, vmid);
    if (match?.node) {
      nodeByVmid.set(vmid, match.node);
      continue;
    }

    const missingEverywhere =
      failures.length > 0 &&
      failures.every(failure => isProxmoxVmMissingMessage(failure.message));
    if (allowMissing && missingEverywhere) {
      continue;
    }

    const details = [
      resourceLookupError ? `cluster resource lookup failed: ${resourceLookupError}` : null,
      failures.length ? `direct lookup failed: ${failures.map(failure => `${failure.node}: ${failure.message}`).join('; ')}` : null
    ].filter(Boolean);
    throw new Error(
      `Unable to resolve Proxmox node for VMID ${vmid}${details.length ? ` (${details.join('; ')})` : ''}`
    );
  }

  return nodeByVmid;
};

export const resolveVmNodeByVmid = async (envSettings, vmid, options = {}) => {
  const nodes = await resolveVmNodesByVmid(envSettings, [vmid], options);
  return nodes.get(Number(vmid)) ?? null;
};

export const cloneQemuVm = async (
  envSettings,
  { sourceNode, sourceVmid, newid, name, targetNode = null, fullClone = true, poolName = null }
) => {
  const payload = await requestJson({
    url: proxmoxApiUrl(envSettings, `nodes/${encodeURIComponent(sourceNode)}/qemu/${sourceVmid}/clone`),
    method: 'POST',
    body: {
      newid,
      name,
      target: targetNode,
      full: fullClone ? 1 : 0,
      pool: poolName || null
    },
    timeoutMs: 60_000,
    ...proxmoxRequestOptions(envSettings)
  });
  return payload?.data ?? null;
};

export const updateQemuVmConfig = async (envSettings, node, vmid, config) => {
  await requestJson({
    url: proxmoxApiUrl(envSettings, `nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`),
    method: 'POST',
    body: config,
    timeoutMs: 60_000,
    ...proxmoxRequestOptions(envSettings)
  });
};

export const startQemuVm = async (envSettings, node, vmid) => {
  const payload = await requestJson({
    url: proxmoxApiUrl(envSettings, `nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/start`),
    method: 'POST',
    timeoutMs: 60_000,
    ...proxmoxRequestOptions(envSettings)
  });
  return payload?.data ?? null;
};

export const shutdownQemuVm = async (envSettings, node, vmid) => {
  const payload = await requestJson({
    url: proxmoxApiUrl(envSettings, `nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/shutdown`),
    method: 'POST',
    timeoutMs: 60_000,
    ...proxmoxRequestOptions(envSettings)
  });
  return payload?.data ?? null;
};

export const stopQemuVm = async (envSettings, node, vmid) => {
  const payload = await requestJson({
    url: proxmoxApiUrl(envSettings, `nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/stop`),
    method: 'POST',
    timeoutMs: 60_000,
    ...proxmoxRequestOptions(envSettings)
  });
  return payload?.data ?? null;
};

export const deleteQemuVm = async (envSettings, node, vmid) => {
  const payload = await requestJson({
    url: proxmoxApiUrl(envSettings, `nodes/${encodeURIComponent(node)}/qemu/${vmid}`),
    method: 'DELETE',
    body: {
      purge: 1,
      'destroy-unreferenced-disks': 1
    },
    timeoutMs: 60_000,
    ...proxmoxRequestOptions(envSettings)
  });
  return payload?.data ?? null;
};

export const ensurePool = async (envSettings, poolName) => {
  const normalizedPoolName = String(poolName ?? '').trim();
  if (!normalizedPoolName) {
    return;
  }

  try {
    await requestJson({
      url: proxmoxApiUrl(envSettings, `pools/${encodeURIComponent(normalizedPoolName)}`),
      method: 'GET',
      ...proxmoxRequestOptions(envSettings)
    });
    return;
  } catch (error) {
    if (!isProxmoxVmMissingMessage(formatProxmoxError(error)) && error.statusCode !== 404) {
      throw error;
    }
  }

  try {
    await requestJson({
      url: proxmoxApiUrl(envSettings, 'pools'),
      method: 'POST',
      body: {
        poolid: normalizedPoolName,
        comment: 'LabFactory prepared VM pool'
      },
      ...proxmoxRequestOptions(envSettings)
    });
  } catch (error) {
    const message = formatProxmoxError(error);
    if (!/already exists/i.test(message)) {
      throw error;
    }
  }
};

export const setVmPoolMembership = async (envSettings, poolName, vmid, { remove = false } = {}) => {
  const normalizedPoolName = String(poolName ?? '').trim();
  if (!normalizedPoolName) {
    return;
  }
  await ensurePool(envSettings, normalizedPoolName);
  await requestJson({
    url: proxmoxApiUrl(envSettings, `pools/${encodeURIComponent(normalizedPoolName)}`),
    method: 'PUT',
    body: {
      vms: String(vmid),
      delete: remove ? 1 : null
    },
    ...proxmoxRequestOptions(envSettings)
  });
};

export const addVmToPool = async (envSettings, poolName, vmid) =>
  setVmPoolMembership(envSettings, poolName, vmid, { remove: false });

export const removeVmFromPool = async (envSettings, poolName, vmid) =>
  setVmPoolMembership(envSettings, poolName, vmid, { remove: true });

export const buildUpdatedNet0Config = ({
  existingNet0,
  bridge,
  firewall = false,
  vlanTag = 0
}) => {
  const raw = String(existingNet0 ?? '').trim();
  if (!raw) {
    return null;
  }

  const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
  const device = parts.shift();
  if (!device) {
    return null;
  }

  const nextParts = [
    device,
    bridge ? `bridge=${bridge}` : null,
    firewall ? 'firewall=1' : null,
    Number(vlanTag) ? `tag=${Number(vlanTag)}` : null
  ].filter(Boolean);
  return nextParts.join(',');
};

export const execQemuGuestAgentCommand = async (
  envSettings,
  node,
  vmid,
  command,
  { timeoutMs = GUEST_AGENT_EXEC_TIMEOUT_MS } = {}
) => {
  const execPayload = await requestJson({
    url: proxmoxApiUrl(envSettings, `nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/exec`),
    method: 'POST',
    body: { command },
    timeoutMs: 15_000,
    ...proxmoxRequestOptions(envSettings)
  });
  const pid = execPayload?.data?.pid;
  if (!pid) {
    throw new Error(`Guest agent did not return a PID for VMID ${vmid}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(GUEST_AGENT_EXEC_RETRY_MS);
    const statusPayload = await requestJson({
      url: proxmoxApiUrl(envSettings, `nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/exec-status?pid=${pid}`),
      method: 'GET',
      timeoutMs: 10_000,
      ...proxmoxRequestOptions(envSettings)
    });
    const status = statusPayload?.data ?? {};
    if (!status.exited) {
      continue;
    }
    const exitCode = status.exitcode ?? status['exit-code'] ?? -1;
    if (exitCode === 0) {
      return status;
    }
    const details = String(status['err-data'] || status['out-data'] || `Exit code: ${exitCode}`).trim();
    throw new Error(`Guest agent command failed on VMID ${vmid}: ${details}`);
  }

  throw new Error(`Timed out waiting for guest agent command on VMID ${vmid}`);
};
