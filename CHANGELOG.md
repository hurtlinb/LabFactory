# Changelog

All notable changes to LabFactory are documented here.

## [Unreleased]

---

## [1.7.3] — 2026-06-25

### Ajouts
- Indicateur d'état Redis dans la sidebar, au même titre que Postgres/Proxmox/Terraform/Ansible
- L'attente de reconnexion post-redémarrage (phase de personnalisation Windows) est désormais suivie VM par VM au lieu d'attendre une seule exécution Ansible globale — une VM lente à reconnecter ne bloque plus la détection des autres ni l'avancement du déploiement. Nouvel état `waiting for reboot` visible dans le détail du déploiement, avec progression individuelle par VM

### Corrections
- **Critique** — Les VM Windows (déploiement et reconnexion post-redémarrage) étaient vérifiées par lots : toutes les VM encore en attente partageaient un seul processus `ansible-playbook` par "round". Plusieurs incidents en cascade en ont découlé (timeout par round trop court pour un lot, `forks` retombé à sa valeur par défaut faute du bon répertoire de travail, stratégie `linear` d'Ansible bloquant tout le lot sur la VM la plus lente) — chacun corrigé tour à tour, mais le problème de fond restait : tant que les VM partagent un processus et une fenêtre de temps communs, une VM lente à démarrer (sysprep Windows 11 notamment) peut retarder ou faire perdre la confirmation de VM par ailleurs déjà prêtes. Remplacé par un modèle où chaque VM a son propre cycle de vérification indépendant (son propre `ansible-playbook`, son propre timeout, son propre backoff), toutes lancées en parallèle — à l'image de ce qui existait déjà pour Linux. Une VM qui bloque n'affecte plus aucune autre VM
- Le délai maximum d'attente d'une VM Windows individuelle (30 min) pouvait être trop court pour un Windows 11 lent à finir son sysprep. Porté à 120 min
- **Critique** — Quand un déploiement échouait après que les VM aient déjà été créées et démarrées dans Proxmox (ex. une VM jamais devenue prête en WinRM), le dashboard l'affichait quand même comme "deploying" avec l'icône qui tourne, indéfiniment. Cause : le calcul du statut affiché dérivait un statut `running`/`mixed` à partir de l'état Proxmox des VM (qui tournent bel et bien), écrasant le vrai statut `failed` avant même qu'il atteigne l'écran. Le statut `failed` est maintenant préservé tel quel, avec une icône et un badge dédiés (page labs, aperçu du dashboard, et tableau des VM par déploiement — les VM jamais confirmées prêtes s'affichent désormais comme `failed` plutôt que `ready`)
- **Critique** — La personnalisation Windows (hostname, timezone, disque, reboot — `windows-playbook.yml`) tournait pour tout le lot de VM en une seule fois, sans tolérance de panne : qu'une seule VM devienne injoignable en cours de route faisait échouer toute la tâche de customisation, même quand toutes les autres VM avaient déjà réussi. Ajout de `ignore_errors`/`ignore_unreachable` sur chaque tâche : une VM injoignable n'empêche plus la personnalisation des autres. Elle sera ensuite identifiée individuellement comme `failed` par le check de reconnexion post-redémarrage (déjà découplé VM par VM), au lieu de faire échouer tout le déploiement
- **Critique** — Le passage à un processus `ansible-playbook` indépendant par VM (ci-dessus) n'a aucune limite de concurrence : sur un lab avec beaucoup de VM Windows, ça peut lancer des dizaines de processus simultanés (~50-60 Mo chacun), ce qui a fait dépasser la limite mémoire du worker (`OOMKilled`, terraform-worker crashé en plein déploiement). Corrigé en augmentant les ressources mémoire des workers plutôt qu'en limitant la concurrence (gitops : terraform-worker 2Gi→4Gi, ansible-worker 3Gi→4Gi)
- Le redéploiement d'une seule VM (`replaceVmids`) pouvait échouer avec `rbd: ... already exists` si un disque Ceph (cloudinit, disque OS) d'une tentative précédente n'avait pas été correctement nettoyé — Terraform ne sait gérer que les ressources dans son propre état, pas les volumes orphelins que Proxmox aurait laissés. Le nettoyage post-destruction existant (déjà utilisé après un `destroy` complet) est désormais aussi exécuté avant un redéploiement ciblé, uniquement pour les VM dont Proxmox confirme l'absence — sans risque pour un remplacement normal où la VM existe encore

---

## [1.7.2] — 2026-06-24

### Corrections
- **Critique** — Tous les jobs Terraform échouaient instantanément (`abortController.signal.setMaxListeners is not a function`). `AbortSignal` est un `EventTarget` standard et n'a pas de méthode `.setMaxListeners()` comme `EventEmitter`. Remplacé par la fonction utilitaire `events.setMaxListeners(n, target)`, qui fonctionne pour les deux

---

## [1.7.1] — 2026-06-24

### Améliorations
- Icônes harmonisées : Reset IP, Reset Password et Redeploy passent du style "badge coloré incrusté" (3ᵉ langage visuel isolé) au style trait ("feather") utilisé par la navigation et les customisations ; l'action "Deploy" utilise désormais un seul glyphe (`⬆`) partout au lieu de deux différents
- Indicateurs d'état (sidebar santé système, état des VM, workers) : les pastilles uniquement colorées sont remplacées par des icônes de forme distincte (`✓ ✗ ! ↻ –`), pour rester utilisables par les personnes daltoniennes

### Performance
- Ansible tournait avec le nombre de forks par défaut (5), limitant la personnalisation des VM (timezone, hostname, jonction domaine, second disque) à 5 hôtes à la fois sur les labs de grande taille. Ajout de `ansible/ansible.cfg` (`forks = 100`)
- Ressources du pod `ansible-worker` augmentées (CPU/mémoire) pour supporter ce parallélisme plus élevé sans throttling ni OOM

### Corrections
- **Critique** — Un job Ansible annulé depuis le dashboard pouvait rester indéfiniment en statut "actif" : `lib/runCommand.js` ne tuait que le process `ansible-playbook` lui-même, pas les workers qu'il forke par hôte (jusqu'à 100 avec le nouveau réglage `forks`). Ces processus orphelins gardaient les pipes stdout/stderr ouverts, empêchant l'événement `close` de Node de se déclencher. Le process est désormais lancé dans son propre groupe (`detached: true`) et l'annulation tue tout le groupe (`process.kill(-pid, ...)`), corrigeant le même risque pour `terraform` au passage

### Notes
- `TERRAFORM_PARALLELISM` a été testé à 64 puis 20 pour accélérer le clonage, mais les deux dépassaient ce que le verrou cluster (`cfs-lock`) de notre pool de stockage Ceph peut sérialiser (`clone failed: cfs-lock 'storage-ceph-pool' error: got lock request timeout`). Revenu à la valeur par défaut du code (10), qui reste la seule valeur confirmée stable sur cette infrastructure

---

## [1.7.0] — 2026-06-22

### Ajouts
- Customisation "Second Disk" (drag & drop, Windows et Linux) : un second disque dur peut être ajouté à une VM depuis le blueprint builder, avec une taille en Go demandée à l'utilisateur
- Case à cocher "Configure the disk" dans la boîte de dialogue : par défaut le disque est automatiquement partitionné, formaté et monté (`/data` sur Linux, nouvelle lettre sur Windows) ; décochée, le disque est attaché brut et laissé à la charge de l'utilisateur de la VM

### Corrections
- Sur Windows, la tâche d'initialisation du second disque échouait silencieusement (`Missing condition in if statement after 'if ('`) : `ansible.builtin.raw` fait transiter la commande par un PowerShell externe qui interpolait `$disk` (non défini à ce niveau) en chaîne vide avant l'exécution du script imbriqué. Remplacé par `ansible.windows.win_powershell`, déjà utilisé pour ce même type de cas dans `windows-domain-playbook.yml`

### Infrastructure
- Ajout de la collection Ansible `ansible.posix` (module `mount`) à l'image `labfactory/worker`, nécessaire au montage automatique du second disque sous Linux

---

## [1.6.1] — 2026-06-19

### Corrections
- **Critique** — Un teacher ne pouvait pas préparer de lab : `GET /api/classrooms` était restreint au rôle `admin` alors que la sélection d'une salle est nécessaire à la préparation d'un lab (page Labs, accessible au teacher). La lecture est désormais ouverte aux rôles `teacher` et `admin` ; la gestion (création/modification/suppression) reste `admin`-only
- **Critique** — Les actions accessibles au teacher (préparer un lab, déployer/démarrer/arrêter/détruire) déclenchaient ensuite un appel admin-only en arrière-plan (`/api/teachers`, `/api/queues`) qui échouait avec `403 forbidden`, affichant un message d'erreur trompeur alors que l'action principale avait réussi. Ces appels sont désormais conditionnés au rôle admin

---

## [1.6.0] — 2026-06-19

### Ajouts
- Gestion des permissions RBAC basée sur deux rôles client Keycloak : `teacher` (accès aux pages du menu Labs) et `admin` (accès complet, y compris Administration)
- Écran "Access denied" pour les comptes authentifiés ne possédant aucun des deux rôles
- Badge de rôle (Admin / Teacher / No role) par utilisateur sur la page Users, basé sur le rôle Keycloak constaté lors de sa dernière activité

### Améliorations
- Interface entièrement traduite en anglais (suppression des dernières chaînes françaises résiduelles)
- Couleurs codées en dur (icônes Reset IP/Password/Redeploy, bannière dev, indicateurs OS) centralisées dans des variables CSS du design system
- Messages "Loading…" et messages d'état vide uniformisés
- Contraste du texte secondaire (`--muted`) renforcé pour la conformité WCAG AA ; `scope="col"` ajouté aux en-têtes de tableaux

### Corrections
- Extraction des rôles Keycloak corrigée : lecture des rôles **client** (`resource_access`) depuis l'access token au lieu des rôles realm
- Masquage RBAC inopérant sur `.shell`, le menu Administration et l'écran d'accès refusé — l'attribut `hidden` était neutralisé par des règles CSS `display` explicites sans `!important`

---

## [1.5.0] — 2026-06-16

### Ajouts
- Réinitialisation du mot de passe administrateur par VM via le guest agent Proxmox (Linux : `chpasswd`, Windows : `Set-LocalUser`)
- Réinitialisation de l'IP par VM via le guest agent Proxmox — modifie le fichier netplan existant (Linux) ou reconfigure l'interface réseau (Windows)
- Changelog accessible depuis le dashboard (icône à côté du numéro de version)
- Numéro de version affiché dans le pied de page : SHA du build en dev, numéro de release en prod

### Améliorations
- Les boutons Reset IP, Reset Password et Redeploy VMs remplacés par des icônes SVG
- Le fichier `terraform-settings.json` est monté via un ConfigMap Kubernetes dans le pod worker Terraform

### Corrections
- Script bash de reset IP réécrit avec `set -e` pour éviter une chaîne `&&` cassée si `grep` ne trouve aucun fichier netplan

---

## [1.4.0] — 2026-06-12

### Ajouts
- Pipeline CI/CD via GitHub Actions : chaque commit sur `main` déploie en dev (tag SHA) ; une GitHub Release déploie en prod (tag semver)
- Dépôt GitOps (`labfactory-gitops`) avec Kustomize base + overlays dev et prod
- Applications ArgoCD pour dev (auto-sync) et prod (sync manuel)

### Améliorations
- Workflow sur branche unique `main` — branche dev supprimée
- Manifests Kubernetes déplacés dans `labfactory-gitops`

---

## [1.3.2] — 2026-06-12

### Ajouts
- Bouton Reset IP par VM (visible uniquement quand le déploiement est en cours)
- Reset via guest agent Proxmox : Linux (netplan) et Windows (cmdlets `NetIPAddress`)
- DNS Swisscom (`195.186.4.162`, `195.186.4.163`) appliqués lors du reset IP

---

## [1.3.1] — 2026-06-12

### Améliorations
- Avertissement de conflit de classroom déplacé sur les actions déployer/démarrer
- Avertissement de conflit limité aux labs actifs

---

## [1.3.0] — 2026-06-12

### Ajouts
- Avertissement de conflit de classroom lors du démarrage d'un lab sur une salle déjà occupée
- Badge initiales du propriétaire sur chaque carte de lab
- Propriétaire du lab actif affiché dans la carte classroom
