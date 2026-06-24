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
