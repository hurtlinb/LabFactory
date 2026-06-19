# Changelog

All notable changes to LabFactory are documented here.

## [Unreleased]

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
