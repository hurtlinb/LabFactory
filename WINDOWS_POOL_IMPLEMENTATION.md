# Suivi d’implémentation — Pool de VM Windows

Créé le 2026-11-19. Statut : P0 (qualification technique) validé le 2026-11-20 ; P1 à démarrer.

Ce document sert de référence commune aux agents et aux développeurs. La création de ce suivi ne signifie pas que les tests sur Proxmox ont été réalisés, ni que la fonctionnalité est implémentée.

## Objectif et contraintes validées

Réduire l’attente au déploiement en réalisant le premier démarrage après Sysprep à l’avance, dans un pool configurable par template Windows.

- Repartir d’une conception neuve ; ne pas restaurer l’ancienne implémentation de pool.
- Toute nouvelle VM Windows destinée à un lab doit provenir du pool, y compris lors d’un redéploiement. Aucun repli vers le clonage direct.
- Si le stock est insuffisant, le déploiement attend.
- Les cartes réseau restent présentes, mais déconnectées pendant la préparation et le stockage dans le pool.
- Les contrôles de préparation passent exclusivement par QEMU Guest Agent (QGA).
- À l’affectation : configurer le réseau Proxmox, puis IP/préfixe/passerelle/DNS via l’agent, vérifier, reconnecter et valider WinRM avant les customizations.
- Les VMID doivent être uniques et vérifiés directement sur Proxmox, pas seulement dans l’inventaire visible par le compte API.
- Le parallélisme est une exigence fonctionnelle de bout en bout : toutes les opérations indépendantes doivent pouvoir progresser simultanément, dans des limites configurables. Augmenter seulement le nombre de workers ou le parallélisme Terraform ne suffit pas.

## Architecture proposée à confirmer après qualification

- Un gestionnaire dédié alimente le pool en arrière-plan via l’API Proxmox.
- Les nouvelles Windows restent gérées par ce service jusqu’à leur destruction ; pas d’import dans Terraform.
- Terraform conserve les nouvelles Linux et les ressources historiques déjà dans ses états.
- L’affectation conserve le VMID et la MAC du pool ; pas de nouveau clonage ou Sysprep.
- Une table persistante relie chaque emplacement logique `(déploiement, poste, VM du blueprint)` à sa VM physique et à son gestionnaire.
- Les VM prêtes restent allumées pour la première version, sous réserve de validation du budget RAM.
- Une VM utilisée dans un lab est détruite après usage, jamais remise dans le stock propre.

Cycle proposé : `creating → preparing → ready → reserved → configuring → assigned → deleting → deleted`, avec `quarantined` pour les situations incertaines.

## Contrat de parallélisme

Cette exigence concerne l’exécution de la fonctionnalité, indépendamment du nombre d’agents qui développent le code. Elle doit être vérifiée à chaque lot, pas ajoutée en optimisation finale.

| Opérations | Parallélisme attendu | Ordre ou exclusion à conserver |
|---|---|---|
| Alimentation du pool | Plusieurs clones et préparations en cours, sur un même template et entre templates | Limites de stockage/nœud/cluster ; unicité des VMID |
| Contrôles QGA et WinRM | Contrôles indépendants entre VM ; une VM lente ne monopolise pas les créneaux de sondage | Contrôle de préparation avant passage à `ready` |
| Réservation des labs | Plusieurs demandes peuvent être traitées ; transactions courtes | Réservation atomique du besoin complet, exclusivité d’une VM et équité entre demandes |
| Déploiement d’un lab mixte | Après réservation des Windows, création Linux et affectation Windows peuvent avancer ensemble | Dépendances réseau et ressources réellement partagées |
| Affectation au lab | Une chaîne de configuration par VM, plusieurs chaînes simultanées | Pour chaque VM : réseau déconnecté → paramètres réseau/identifiants → vérification → connexion → WinRM |
| Customizations | Préparations Linux/Windows et postes indépendants en parallèle ; démarrage dès que leurs prérequis sont validés | Ordre des tâches d’une VM, contrôleur/DNS prêt avant jonction de ses membres, barrières métier explicites |
| Start, stop, remplacement et destruction | Plusieurs VM et labs indépendants progressent simultanément | Exclusion des mutations concurrentes sur une même VM ; validation finale du lab après tous les résultats |
| Réapprovisionnement pendant un déploiement | Continuer à remplir le pool pendant les affectations et customizations | Réserver des ressources aux opérations utilisateur pour éviter leur famine |

La sérialisation doit être locale aux dépendances réelles : une VM ne doit pas attendre la plus lente du lab pour poursuivre une étape indépendante. Les dépendances Active Directory doivent être rattachées au poste/réseau/domaine concerné, pas à tous les domaines de tous les labs. Les barrières métier existantes, notamment la validation avant mutation et l’interdiction d’exécuter des tâches personnalisées d’injection de panne après un échec de préparation, doivent être documentées et conservées tant que leur sémantique n’a pas été explicitement revue.

Les plafonds doivent distinguer clones en cours, préparations Windows en cours, requêtes API/sondages, affectations et customizations. Ils doivent s’appliquer à l’ensemble des workers/réplicas concernés, avec des budgets par cluster, stockage ou nœud lorsque nécessaire ; une limite locale multipliée par le nombre de pods n’est pas un plafond global. Les valeurs seront définies par mesure sur l’infrastructure, sans supposer un gain linéaire.

Les attentes de stock, délais entre sondages et backoffs ne doivent pas monopoliser un créneau d’exécution ni un verrou global. Une tâche Proxmox encore active continue en revanche à compter dans son budget d’opérations en cours, même si son worker redémarre : réconciliation avant libération/réattribution de ce budget. Prévoir équité entre labs/templates et absence d’interblocage entre limites.

Le verrou actuel `global:terraform-deploy` doit être audité : il ne doit couvrir ni les affectations Windows, ni les attentes QGA/WinRM, ni les customizations du nouveau parcours. Prévoir des verrous par déploiement/workspace et par VM, ainsi que des budgets pour les ressources partagées ; toute évolution du verrou historique doit être validée avec les labs existants et les collisions VMID. Plusieurs labs indépendants doivent pouvoir avancer, sans lancer deux opérations contradictoires sur le même lab.

## Coordination entre agents

1. Lire ce document et les instructions du dépôt avant toute intervention.
2. Prendre un lot dans le tableau ci-dessous, indiquer son responsable et son périmètre avant de modifier les fichiers. Vérifier qu’aucun autre agent ne travaille sur les mêmes fichiers.
3. Respecter les dépendances : ne pas construire l’orchestration avant validation du parcours Windows hors réseau.
4. Décrire ici toute modification d’un contrat partagé (schéma, états, payloads, API, propriété des VM) avant que les autres lots s’appuient dessus.
5. Ne pas écraser les modifications d’un autre agent. Coordonner explicitement les fichiers partagés, notamment `dashboard/server.js` et les workers.
6. À la fin d’un lot, renseigner fichiers modifiés, tests exécutés, résultats, limites et prochaine action. Ne cocher que ce qui est effectivement vérifié.
7. Distinguer tests simulés et tests sur infrastructure réelle. Ne jamais consigner de secrets dans ce document.
8. Ce suivi ne donne pas une autorisation générale de créer, modifier ou détruire des VM de production : respecter le périmètre de travail autorisé dans la session.
9. Pour chaque lot, identifier ce qui s’exécute en parallèle, les limites partagées et les seules dépendances séquentielles. Joindre des preuves de chevauchement des opérations et de respect des plafonds lors de sa validation.

Statuts : `à faire`, `en cours`, `bloqué`, `à relire`, `validé`.

| Lot | Dépendances | Responsable | Statut | Preuves / référence |
|---|---|---|---|---|
| P0 — Qualification sur une VM | Aucune | Codex, Claude | validé | Série linked clone 4/4 réussie : `output/p0-2026-11-20T08-35-17-595Z.json` ; validé par l’utilisateur le 2026-11-20 ; VM de test détruites |
| P1 — Contrats et données | P0 | Claude | validé | Migration 032, `lib/windowsPool/`, tests unitaires + 11 tests PostgreSQL réussis ; plage VMID vérifiée libre ; garde Terraform hors plage du pool ; validé par l’utilisateur le 2026-11-20 |
| P2 — Préparation et alimentation | P1 | Claude | à relire | Manager + worker ; 9 tests simulés ; qualification réelle réussie (`output/p2-2026-11-20T10-08-58-481Z.json`) ; déploiement Kubernetes restant |
| P3 — Réservation et attente | P1, P2 | Claude | à relire | Coordinateur, attente BullMQ, annulation vérifiée ; 6 tests P3 + 60/60 au total ; branchement dans le déploiement reporté à P4 |
| P4 — Affectation et customizations | P2, P3 | Claude | à relire | P4a (qualifié sur A43), P4b (non activé), P4c, P4d ; suite 235/0 ; validation cluster de bout en bout après P5 |
| P5 — Cycle de vie et compatibilité | P4 | Claude | à relire | Plan effectif, propriété, destroy multi-gestionnaires, redeploy par remplacement, audit dev ; suite 246/0 ; validation cluster restante |
| P6 — Interface, supervision et activation | P5 | Claude | à relire | Page admin, API, qualification obligatoire (033), annulation des labs en attente ; suite 255/0 ; reste : mesures customization/délai total et attente des verrous |

## P0 — Première action : qualifier une VM Windows

Objectif : prouver le parcours complet avant de développer le gestionnaire du pool.

- [x] Identifier un template représentatif, un réseau de test et le périmètre Proxmox autorisé.
- [x] Consigner les versions Windows, Proxmox, QGA et Cloudbase-Init utilisées.
- [x] Vérifier un VMID libre, cloner sans démarrer, imposer et relire la déconnexion de toutes les NIC avant le premier démarrage.
- [x] Laisser terminer les étapes post-Sysprep et Cloudbase-Init sans réseau.
- [x] Vérifier via QGA la fin effective de la préparation ; un simple ping agent ou `done.flag` ne suffit pas.
- [x] Identifier la NIC Windows par sa MAC, même si elle est déconnectée.
- [x] Configurer bridge/VLAN puis IP, préfixe, passerelle, DNS et mot de passe via QGA, lien toujours coupé.
- [x] Relire la configuration, connecter la NIC et tester WinRM depuis le worker.
- [x] Exécuter une customization simple, redémarrer et vérifier la persistance réseau/mot de passe.
- [x] Mesurer séparément préparation, affectation et customization.
- [x] Après réussite sur une VM, qualifier un petit lot de VM simultanées dans le périmètre autorisé : vérifier le chevauchement de préparation/affectation et comparer à une exécution séquentielle équivalente. (Comparaison biaisée par le cache, voir réserve.)
- [x] Documenter le résultat et le devenir de la VM de test.

Critère de passage : VM utilisable sans nouveau Sysprep, préparation vérifiable hors réseau, configuration conservée après redémarrage. Tout blocage doit être résolu avant P1/P2.

### Résultats préliminaires P0 — 2026-11-19

- Accès authentifié à l’API Proxmox vérifié : inventaire lu avec réponse HTTP 200.
- Version retournée par l’API : Proxmox 9.2.31 (release 9.2).
- Templates Windows recensés : `112 / Win22CBI`, `113 / Win11CBI`, `147 / Win22v2`, `148 / Win11v2` sur `peda-pve2`, et `150 / Win25v1` sur `peda-pve1`.
- Configurations 112 et 113 inspectées : QGA activé, NIC VirtIO sur `vmbr0`, disque Cloud-Init présent. Ce constat ne prouve pas que l’agent fonctionne dans un clone ni que la préparation hors réseau réussit.
- La configuration locale mentionne un nœud `pve1` et un template `labfactory-template` qui ne correspondent pas aux noms observés : ne pas les utiliser aveuglément pour le pilote.
- Aucune VM créée, démarrée ou modifiée ; aucun VMID réservé. La sélection du template pilote et du réseau de test reste à finaliser. Les informations réseau ont été demandées à l’utilisateur.

### Exécution P0 — 2026-11-20

- Périmètre confirmé par l’utilisateur : template **147 / Win22v2**, réseau de la salle **A43**, toutes les VM de test dans le pool **labs-dev**.
- Configuration A43 lue dans la base du dashboard `labfactory-dev` : 22 postes, VLAN initial 72 incrémenté par poste, réseau initial `10.10.72.0/25`, passerelle `10.10.72.1`.
- Pilote créé : **151 / labfactory-p0-win22-151**, nœud `peda-pve2`, pool `labs-dev` vérifié après clonage. VMID obtenu puis vérifié via `cluster/nextid?vmid=151` avant clonage complet du template 147.
- Clonage lancé le 2026-11-20 à 08:00 CET, terminé avec résultat Proxmox `OK`. Avant premier démarrage : `onboot=0`, NIC conservée avec MAC `BC:24:11:16:3B:F8`, `bridge=vmbr0,firewall=1,link_down=1` relu et vérifié. Premier démarrage effectué hors réseau.
- Adresse candidate pour l’affectation : `10.10.72.120/25`. L’inventaire des configurations Proxmox sur VLAN 72 utilise `.20`, `.101` et `.102` ; `.120` n’y apparaît pas. Un test TCP négatif ne prouve pas à lui seul la disponibilité d’une IP. Adresse pas encore appliquée ; NIC pas encore reconnectée.
- En cours : attente de QGA puis contrôle de fin de préparation. Pas encore de preuve de réussite Sysprep/Cloudbase-Init ni de validation WinRM.
- Résultats suivants : Windows Server 2022 Standard, build `10.0.20348`, atteint `IMAGE_STATE_COMPLETE`, `SystemSetupInProgress=0`, `OOBEInProgress=0` hors réseau. QGA était joignable avant la fin OOBE : le ping seul est bien insuffisant. Cloudbase-Init termine ses plugins vers 08:05:08 CET, soit environ 3 min 13 s après le lancement du premier démarrage (08:01:55 CET).
- Cloudbase-Init s’arrête, `done.flag` existe et les quatre plugins portent la valeur 1. Toutefois, le log signale `Invalid Debian config to parse` avec une configuration réseau vide : **ne pas considérer ce bootstrap comme exempt d’erreurs**. Le futur contrat de préparation doit fournir des métadonnées cohérentes ou exclure explicitement ce plugin pendant le pool.
- Affectation expérimentale réussie : VLAN 72, `10.10.72.120/25`, passerelle `10.10.72.1`, DNS `195.186.4.162` et `195.186.4.163` (valeurs du chemin reset IP existant, pas des champs de la salle). NIC identifiée par MAC. `New-NetIPAddress` a échoué lien déconnecté avec une incohérence DHCP/PersistentStore ; `netsh interface ipv4 set address ... store=persistent` a fonctionné via QGA. Configuration relue avant connexion ; adresse ensuite dans l’état `Preferred`.
- Sur le **clone uniquement**, Cloudbase-Init a été désactivé après sa fin pour empêcher la réapplication de métadonnées provisoires. Mot de passe Administrator remplacé via QGA par une valeur aléatoire temporaire non consignée. Aucun changement sur le template 147.
- WinRM HTTPS validé depuis `labfactory-ansible-worker` dans `labfactory-dev` : écriture puis lecture de `C:\ProgramData\LabFactoryP0\customization.txt`, résultat 0. Redémarrage de validation demandé ; persistance à vérifier.
- Après redémarrage (boot 08:09:13 CET), QGA confirme : `IMAGE_STATE_COMPLETE`, IP/préfixe/passerelle/DNS conservés, adresse `Preferred`, fichier de customization conservé, Cloudbase-Init arrêté/désactivé. La persistance du mot de passe n’a pas été retestée par authentification après reboot, le secret temporaire n’ayant pas été conservé.
- Fin de cette première séance : NIC redéconnectée (`link_down=1`), arrêt propre effectué et état `stopped` confirmé par l’API ; appartenance à `labs-dev` revérifiée. Ne pas supprimer cette VM sans consigner son devenir.
- **P0 reste en cours, non validé** : résoudre/requalifier le contrat de métadonnées réseau Cloudbase-Init, relever les versions QGA/Cloudbase-Init, retester WinRM avec le même mot de passe après reboot, puis réaliser le petit lot concurrent et la comparaison chronométrée. Le test de customization réalisé est une commande PowerShell via WinRM depuis le worker, pas encore le pipeline Ansible complet.

### Requalification P0 — 2026-11-20, à partir de 08:14 CET

- Suite expérimentale lancée : deux nouveaux clones traités successivement, puis deux clones traités simultanément, tous issus de 147 dans `labs-dev`. Le pilote 151 reste arrêté et déconnecté.
- Correction à vérifier : fournir `citype=configdrive2`, `ipconfig0=ip=dhcp`, un compte Administrator et un mot de passe provisoire explicites **avant le premier boot**, avec toutes les NIC en `link_down=1`. Vérifier le contenu réseau généré avant démarrage et l’absence d’erreurs Cloudbase-Init après préparation.
- Les identifiants d’affectation sont distincts des identifiants provisoires et conservés seulement en mémoire pendant l’essai, pour retester les mêmes identifiants après reboot. Les inventaires Ansible temporaires du worker sont supprimés à la fin.
- Le test utilise les étapes `setup` et `reboot` du playbook Windows déployé sur le worker de développement, une copie de fichier Ansible, puis une vérification authentifiée du nom, fuseau, fichier, IP, passerelle et DNS après reboot.
- Preuves horodatées de cette tentative : `output/p0-2026-11-20T07-14-53-675Z.json`. Ce fichier est un résultat de qualification, pas une configuration d’application. Ne pas conclure avant son résultat final et la vérification du devenir des VM.

#### Issue de la tentative 08:14 — constat du 2026-11-20 (vérifié via l’API Proxmox)

- **Tentative interrompue, sans résultat final** : le rapport n’a ni `finishedAt` ni `success` ; dernier événement à 08:18:36 CET sur la VM 152 (première VM séquentielle). Les VM 153/154 (parallèles) n’ont jamais été créées.
- Devenir des VM (historique des tâches Proxmox) : **151** détruite à 08:18:53 CET ; **152** arrêt propre interrompu à 08:18:46, `qmstop` à 08:19:27, détruite à 08:20:38. Ces actions ont été exécutées par `root@pam` (session interactive), pas par le jeton `root@pam!labfactory` du harnais. Aucune VM de test P0 ne subsiste dans `labs-dev` ; VMID 151–155 libres.
- Observé sur 152 avant interruption : métadonnées réseau configdrive2 générées avec `iface eth0 inet dhcp` et DNS `10.1.0.20`/`10.1.0.21`, recherche `emfnet.ch` (valeurs par défaut du nœud, à maîtriser explicitement). QGA indisponible pendant ~1 min après le boot, puis `IMAGE_STATE_UNDEPLOYABLE` → `IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE` (redémarrage de phase Sysprep) ; Cloudbase-Init pas encore exécuté. **Aucune conclusion possible** sur l’absence d’erreur `Invalid Debian config to parse` avec configdrive2.
- Versions relevées : Windows Server 2022 Standard build `10.0.20348`, Proxmox `9.2.31`, QEMU Guest Agent `110.0.2`, Cloudbase-Init `1.1.6`.
- Prochaine action : relancer la requalification complète (2 séquentielles + 2 parallèles) avec l’accord explicite de l’utilisateur, sans interruption manuelle ; le harnais jetable est `tmp/p0-complete.mjs` (hors code applicatif).

#### Décision : linked clones — 2026-11-20

- **Exigence utilisateur : les VM du pool sont des linked clones (`full=0`), pas des clones complets.** Les tentatives précédentes (151, 152) étaient des clones complets : leurs durées de clonage (~1 min 20 s) ne sont pas représentatives.
- Faisabilité : template 147 sur `ceph-pool` (RBD), disques `base-147-disk-*` → linked clone supporté.
- Conséquences à intégrer en P1/P2 : une VM du pool dépend de son template de base ; un template ne peut être supprimé ou remplacé tant que des linked clones existent ; une nouvelle révision de template doit être un nouveau template (nouveau VMID), avec vidange du stock de l’ancienne révision ; le placement est contraint au stockage du template.
- Relance du 08:59 CET (`output/p0-2026-11-20T07-59-12-654Z.json`) lancée par erreur en clone complet, arrêtée à la demande de l’utilisateur pendant le clonage de 151. La tâche Proxmox interrompue a laissé **151 orpheline** (`lock=clone`, hors `labs-dev`) : nettoyage à faire (`unlock` puis destruction), après accord.
- Harnais corrigé (`full: 0`).
- Nettoyage de 151 impossible via le jeton API : `skiplock` est réservé à `root@pam`. À faire sur `peda-pve2` : `qm unlock 151 && qm destroy 151 --purge --destroy-unreferenced-disks 1`.
- Relance linked clone 09:02 CET (`output/p0-2026-11-20T08-02-09-681Z.json`) : **échec immédiat du clonage**, `cfs-lock 'storage-ceph-pool' error: got lock request timeout`. Aucune VM créée (152 absente). Hypothèse à vérifier : verrou de stockage encore tenu par le clone complet interrompu (processus de copie RBD résiduel). À vérifier sur le nœud avant toute nouvelle tentative.
- Nettoyage de 151 fait par l’utilisateur sur le nœud (`qmdestroy` 09:03 CET, 2 avertissements).

#### Série linked clone 09:04 CET — `output/p0-2026-11-20T08-04-10-388Z.json`

- **Linked clone confirmé** : `scsi0=ceph-pool:base-147-disk-1/vm-151-disk-1`, clonage en **3,2 s** (contre ~1 min 20 s en clone complet), VM dans `labs-dev`.
- **Préparation hors réseau réussie, sans erreur Cloudbase-Init** : `IMAGE_STATE_COMPLETE`, `done.flag`, 4 plugins = 1, `errorCount=0`, aucun reboot en attente, NIC `Disconnected`. Le correctif `citype=configdrive2` + `ipconfig0=ip=dhcp` + compte/mot de passe provisoires avant premier boot **résout `Invalid Debian config to parse`**. Durée boot → prête : **10 min 25 s** (deux cycles QGA indisponible : specialize puis OOBE). À comparer en série ; plus long que la mesure du pilote (3 min 13 s, mesurée jusqu’à la fin des plugins seulement).
- Métadonnées réseau générées : DHCP + DNS `10.1.0.20`/`10.1.0.21`, recherche `emfnet.ch` (valeurs par défaut du nœud, sans effet ici car NIC déconnectée puis IP statique).
- **Échec à l’affectation, défaut réel** : après Cloudbase-Init l’interface est en DHCP. Lien coupé, `netsh … source=static store=persistent` ajoute l’IP statique mais **laisse `EnableDHCP=1`** ; `Set-NetIPInterface -Dhcp Disabled` (stores actif et persistant) est également sans effet persistant. État obtenu : DHCP activé + APIPA `169.254.x` + IP statique. Une reconnexion aurait aussi pris un bail DHCP.
- **Correctif qualifié sur 151 (hors réseau)** : écrire `EnableDHCP=0` dans `HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{GUID}` + `Set-NetIPInterface -Dhcp Disabled`, puis `netsh` statique. Après reboot (09:19:05) : DHCP `Disabled`, IP/passerelle/DNS conservés. Lien coupé, Windows affiche toujours une APIPA `WellKnown` (artefact de média déconnecté) ; **lien connecté : une seule adresse, `10.10.72.121/25 Manual Preferred`**. NIC redéconnectée, 151 arrêtée et conservée dans `labs-dev`.
- Contrat de vérification d’affectation retenu : lien coupé → `EnableDHCP=0`, DHCP `Disabled`, IP cible unique (APIPA tolérée) ; après connexion → exactement une IPv4, cible, `Preferred`. Harnais corrigé en conséquence ; série complète relancée (VMID à partir de 152).

#### Série 09:21 CET — `output/p0-2026-11-20T08-21-52-621Z.json`

- VM 152 (linked clone, 6 s) : préparation hors réseau 10 min 31 s sans erreur ; **affectation réussie avec le correctif DHCP** (vérif. lien coupé : IP unique, DHCP `Disabled` ; après connexion : 1 seule IPv4, `Preferred`) ; affectation 52 s.
- Ansible `setup` réussi (nom d’hôte, fuseau ; 20 s). Puis **arrêt code 137** : le pod `labfactory-ansible-worker` a été remplacé pendant l’exécution par le déploiement de l’image `worker-c02df67` (~09:33 CET). Cause externe, pas un défaut du parcours. 152 garée arrêtée/déconnectée dans `labs-dev`.
- Enseignement P4 : un rollout du worker tue les customizations en cours (`kubectl exec`/jobs) ; il faut un arrêt gracieux et une reprise idempotente de l’étape, sans recommencer l’affectation.
- Série relancée après vérification du nouveau pod (VMID à partir de 153).

#### Série complète 09:35 CET — **réussie** — `output/p0-2026-11-20T08-35-17-595Z.json`

`success: true` : 4/4 VM linked clone de 147 dans `labs-dev`, chacune préparée hors réseau sans erreur Cloudbase-Init, affectée via QGA (correctif DHCP), connectée, puis Ansible `setup` → marqueur `win_copy` → `reboot` → vérification authentifiée **avec les mêmes identifiants** : nom d’hôte, fuseau, fichier, IP/préfixe `Preferred`, passerelle, DNS, Cloudbase-Init désactivé.

| VM | Mode | Clone | Préparation | Affectation | Ansible (setup/marqueur/reboot/vérif) | Total |
|---|---|---|---|---|---|---|
| 153 | séquentiel | 3 s | 11 min 14 s | 52 s | 6 min 04 s (25/67/198/64 s) | 18 min 14 s |
| 154 | séquentiel | 6 s | 8 min 35 s | 47 s | 4 min 09 s (24/63/117/34 s) | 13 min 37 s |
| 155 | parallèle | 3 s | 6 min 32 s | 55 s | 4 min 01 s (25/60/112/33 s) | 11 min 31 s |
| 156 | parallèle | 6 s | 6 min 14 s | 48 s | 4 min 04 s (27/61/111/34 s) | 11 min 12 s |

- **Chevauchement prouvé** : 155/156 clonées à 2 ms d’écart, préparations, affectations et Ansible simultanés (voir `events`). Deux VM en séquentiel : ~33 min ; deux VM en parallèle : **11 min 31 s**, aucune erreur ni dégradation par VM.
- **Réserve sur la comparaison** : la durée de préparation décroît au fil des runs (674 → 515 → 392/374 s), probablement effet de cache Ceph/RBD sur l’image de base ; conditions non strictement comparables. Le gain réel du parallélisme est donc surestimé ici ; à remesurer avec ordre alterné avant de fixer les plafonds.
- **Gain attendu du pool pour l’utilisateur** : retire clone + préparation (6–11 min) du chemin critique ; il reste affectation (~50 s) + customizations.
- Limites : customization = tags `setup`/`reboot` du playbook dev + `win_copy`, pas le pipeline complet des labs (AD, blocs, injection de panne) ; DNS de test = valeurs du reset IP existant ; WinRM en transport `basic` HTTPS sans validation de certificat (comme le worker actuel) ; un seul template (147) qualifié.
- **Devenir des VM** : 151 à 156 détruites le 2026-11-20 sur demande de l’utilisateur (`purge`, disques non référencés supprimés ; identité nom/description/pool/état vérifiée avant chaque destruction ; 6/6 `OK`). Aucune VM de test P0 ne subsiste.
- **P0 validé par l’utilisateur le 2026-11-20.**
- Enseignement P2 : interrompre une tâche `qmclone` via l’API laisse une VM verrouillée hors pool et peut bloquer le stockage ; le gestionnaire ne doit jamais annuler un clone en cours, mais attendre et réconcilier. Les erreurs `cfs-lock` doivent être traitées comme transitoires, avec backoff et sans compter comme échec de la VM.

## P1 — Contrats et données

- [x] Définir la configuration par template : activation, réserve prête cible, capacité maximale, parallélisme, placement, révision et timeout.
- [x] Définir inventaire et affectations : cluster, VMID, nœud, template/révision, identité de propriété, emplacement logique, gestionnaire, état, checkpoints, erreurs et dates.
- [x] Prévoir l’historique des remplacements et une seule affectation active par emplacement logique.
- [x] Ajouter contraintes d’unicité, transactions de réservation et contrôle de version des opérations.
- [x] Définir le contrat QGA : commandes, délais, résultats structurés, erreurs, annulation et protection des secrets.
- [x] Définir le graphe de dépendances, les plafonds distribués par catégorie d’opération, les règles d’équité et les verrous par lab/workspace/VM.
- [x] Créer une nouvelle migration après la dernière existante ; ne pas réutiliser les migrations historiques du pool.
- [x] Exécuter les tests PostgreSQL (`tests/windowsPool.db.test.js`) sur une base réelle : 2026-11-20, PostgreSQL 17.11 de `labfactory-dev` via `kubectl port-forward`, schéma isolé `wpool_test_*` supprimé ensuite ; **11/11 réussis** (contraintes, allocation VMID concurrente, réservation tout-ou-rien, 2 demandes concurrentes, FIFO, suspension/plafond, annulation, affectations, plafonds distribués à 10 tentatives concurrentes, bail lié à une tâche Proxmox, contrôle optimiste). Chaîne complète 001→032 appliquée comme le dashboard (une transaction par fichier) dans un schéma isolé, puis 032 rejouée : OK ; schéma supprimé, aucune table créée dans `public`.

### Contrats P1 — référence pour P2 à P6

Fichiers : `db/migrations/032-windows-pool.sql`, `lib/windowsPool/{states,config,qga,reservation,leases,vmidAllocator,dependencies}.js`, tests `tests/windowsPool.test.js` (unitaires) et `tests/windowsPool.db.test.js` (PostgreSQL, activé par `WINDOWS_POOL_TEST_DATABASE_URL`). Aucun worker ni `dashboard/server.js` modifié : le schéma est inerte tant que P2 n’est pas livré (pool `paused` par défaut, templates désactivés).

**Données (migration 032, idempotente car `runMigrations.ts` rejoue tous les fichiers)**

| Table | Rôle | Garanties |
|---|---|---|
| `windows_pool_settings` | Ligne unique : cluster, plage VMID (défaut **70000–79999**, hors plage Terraform 10000–~60100), `paused` (défaut **true**) | Plage bornée et cohérente |
| `windows_pool_templates` | Config par template : `enabled`, `ready_target`, `max_capacity`, `max_parallel_preparations`, `node`, `storage`, `revision`, `source_template_vmid`, timeouts | `clone_mode = 'linked'` imposé ; cible ≤ plafond ; template activé ⇒ nœud + stockage. FK `RESTRICT` sur `vm_templates` : désactiver/supprimer la config avant de supprimer un template |
| `windows_pool_vms` | Inventaire physique ; `id` = identité de propriété écrite dans Proxmox (`labfactory-pool:<id>`) | VMID unique parmi les VM vivantes ; `version` pour contrôle optimiste ; demande obligatoire dès `reserved` |
| `windows_pool_vm_events` | Journal des transitions | Écrit dans la même instruction que la transition |
| `windows_pool_requests` | Demande d’un deploy/redeploy : `demand = [{templateId, count}]`, `status`, `blocked_reason` | Une seule demande active par lab |
| `lab_vm_assignments` | Emplacement logique `(déploiement, poste, VM blueprint)` → VM physique + gestionnaire (`windows-pool` ou `terraform`) ; historique via `replaces_assignment_id` | Une affectation active par emplacement ; **une VM du pool affectée au plus une fois de sa vie** ; VMID actif unique |
| `windows_pool_operation_limits` / `_leases` | Plafonds distribués par catégorie (`clone`, `prepare`, `guest_probe`, `assign`, `customize`, `lifecycle`, `destroy`) et portée (`cluster`, `node:x`, `storage:x`) | Voir ci-dessous |

FK `RESTRICT` vers `lab_deployments` (demandes, affectations) : la suppression d’un lab devra d’abord clore ses affectations (P5).

**Cycle de vie** (`states.js`) : `creating → preparing → ready → reserved → configuring → assigned → deleting → deleted`, `quarantined` depuis tout état non terminal, sortie uniquement vers `deleting`. Retour `reserved → ready` seulement pour une réservation intacte et revérifiée (annulation). Aucun retour au stock depuis `configuring`/`assigned`. `transitionPoolVm` échoue (`POOL_VM_STALE`) si un autre worker a modifié la VM.

**Réservation** (`reservation.js`) : transaction courte ; tout ou rien ; `FOR UPDATE SKIP LOCKED` ; FIFO par template (`QUEUED_BEHIND_OLDER_REQUEST`, pas de famine des gros labs) ; révision résolue au moment de la réservation (révision active du template) ; motifs de blocage explicites `POOL_PAUSED`, `TEMPLATE_DISABLED`, `DEMAND_EXCEEDS_CAPACITY`, `INSUFFICIENT_STOCK` ; jamais de clonage direct. Annulation : seules les VM `reserved` revérifiées intactes par l’appelant reviennent en `ready`, les autres passent en `deleting`. Canal `pg_notify` : `windows_pool_stock`.

**Réapprovisionnement** (`config.js`, `planReplenishment`) : objectif = réserve + demande en attente ; borné par plafond (stock = creating + preparing + ready) et par préparations parallèles ; signale `DEMAND_EXCEEDS_CAPACITY`.

**Plafonds distribués** (`leases.js`) : acquisition multi-portée atomique dans PostgreSQL (verrous consultatifs triés, sans attente → pas d’interblocage) ; refus = aucune ressource tenue, l’appelant réessaie en backoff sans garder de créneau worker. Un bail expiré **sans** tâche Proxmox est récupérable ; un bail lié à une tâche (`proxmox_upid`) **continue de compter** jusqu’à réconciliation (`reconcileOrphanLeases`, défaut prudent si Proxmox ne répond pas). Les catégories séparées (`assign`/`customize` vs `clone`/`prepare`) réservent la capacité des opérations utilisateur face au réapprovisionnement. Valeurs initiales prudentes (clone 2, prepare 4, guest_probe 8, assign 4, customize 5, lifecycle 8, destroy 4) à recalibrer par mesure.

**VMID** (`vmidAllocator.js`, `lib/vmidAvailability.js`) — plage **70000–79999 validée par l’utilisateur** le 2026-11-20, avec l’exigence que ces VMID soient libres et jamais utilisés par d’autres labs :
- **État initial vérifié le 2026-11-20** (lecture seule) : aucun guest visible dans la plage (435 guests, 4 nœuds, VMID max existant 59862), aucun volume `vm-7xxxx` sur les stockages, et `cluster/nextid?vmid=N` confirme les **10 000** VMID libres (y compris guests invisibles au jeton).
- **À chaque création d’une VM du pool** : `createProxmoxVmidCheck` exige l’accord de trois sources — registre du cluster (`nextid?vmid=N`), inventaire `cluster/resources` (aucun guest, template compris), contenu du stockage cible (aucun disque `vm-N-*`/`base-N-*` orphelin) — en plus des exclusions base (VM vivantes du pool, affectations actives Terraform et pool) et de l’index unique. **P2 doit rappeler ce contrôle juste avant le `POST clone`** (pas seulement à l’allocation). Collision résiduelle au clonage : ne jamais adopter ni détruire une VM sans le marqueur `labfactory-pool:<id>`.
- **Côté autres labs** : `checkPlannedVmids` refuse toute création Terraform dans la plage du pool (lue dans `windows_pool_settings`, défaut 70000–79999 si la migration n’est pas appliquée, blocage si la lecture échoue), avant tout appel Proxmox. Branché dans `workers/terraformWorker.js` (seule modification de worker de P1). Les VMID Terraform calculés restent ≤ ~60100.
- Parcours circulaire après le dernier VMID (pas de réutilisation immédiate).

**Contrat QGA** (`qga.js`) :
- Exécution PowerShell encodée ; **secrets via stdin (`input-data`)**, jamais en ligne de commande ; sorties expurgées et enveloppe CLIXML retirée.
- Préparation : sonde P0 + marqueur `C:\ProgramData\LabFactory\pool-ready.json` `{poolVmId, revision}`. Codes non fatals (attente) : `AGENT_UNAVAILABLE`, `SETUP_IN_PROGRESS`, `CLOUDBASE_RUNNING`, `MARKER_MISSING` ; fatals (quarantaine) : `BOOTSTRAP_ERRORS`, `PLUGIN_STATE_INVALID`, `BOOTSTRAP_REBOOT_PENDING`, `NIC_CONNECTED`, `MARKER_MISMATCH` (marqueur hérité/erroné). L’écriture du marqueur désactive Cloudbase-Init.
- Affectation : validation stricte (MAC, IPv4, préfixe 8–30, passerelle dans le sous-réseau, 1–4 DNS) ; NIC par MAC ; `EnableDHCP=0` via registre (correctif P0) ; vérification lien coupé (APIPA tolérée, DHCP désactivé, IP unique, passerelle, DNS) puis après connexion (exactement une IPv4, `Preferred`).
- Délais : sonde 60 s, affectation 120 s, sondage 1,5 s, agent indisponible 8 s ; annulation par `AbortSignal` côté appelant (P2).

**Graphe de dépendances** (`dependencies.js`) : chaîne par VM (`assign-network → connect → winrm → setup → files → reboot → reconnect [→ domain]`) ; jonction AD d’un membre dépendante du contrôleur du **même domaine et même réseau /24** uniquement ; barrière métier conservée : injection de panne (`tasks`) seulement si toutes les préparations ont réussi. `nextSteps` rend tout ce qui est exécutable immédiatement.

**Verrous** : `lab:<deploymentId>` (existant, exclusion des opérations contradictoires sur un lab) ; mutations d’une VM du pool protégées par `version` (pas de verrou long) ; ressources partagées par baux. Le nouveau parcours ne doit **pas** prendre `global:terraform-deploy` ; il reste requis pour les plans Terraform (Linux et historiques) tant que son audit (P2/P4) n’est pas fait.

## P2 — Préparation et alimentation

- [x] Créer un worker dédié indépendant du verrou global Terraform (`workers/startWindowsPoolWorkerService.js`, `npm run windows-pool-worker`).
- [x] Centraliser l’allocation des VMID (`allocatePoolVm`) ; rappeler `createProxmoxVmidCheck` (registre + inventaire + volumes) **juste avant chaque clone**, et traiter les collisions sans adopter ni détruire de VM étrangère.
- [x] Journaliser les tâches Proxmox et réconcilier les résultats incertains avant répétition.
- [x] Garantir la déconnexion persistante des NIC avant tout démarrage.
- [x] Créer un marqueur de préparation lié à la VM et à la révision, distinct de la disponibilité du boot courant.
- [x] Empêcher Cloudbase-Init de réappliquer les paramètres provisoires après affectation.
- [x] Limiter les préparations simultanées et renouveler le stock selon réserve et demandes en attente.
- [x] Exécuter clones et préparations en parallèle entre VM/templates ; appliquer des budgets partagés entre réplicas et réconcilier les opérations toujours actives après crash.
- [x] Limiter les sondages individuellement, sans garder leur créneau pendant les backoffs ou l’attente de fin de préparation.
- [x] Gérer les nouvelles révisions, la quarantaine et les reprises après arrêt du worker.
- [x] Qualifier le worker sur l’infrastructure réelle (voir « Qualification P2 » ci-dessous).
- [x] Manifeste Kubernetes du worker (dépôt `labfactory-gitops`), **dev uniquement**, préparé le 2026-11-20 sur la branche locale `feature/windows-pool-worker-dev` (commit `c73581b`, **non poussé**) : `overlays/dev/windows-pool-worker.yaml` + référence dans `overlays/dev/kustomization.yaml`. Hors `base/` car `overlays/prod` inclut `base` ; rendu `kubectl kustomize overlays/prod` **identique octet pour octet** avant/après ; dry-run serveur accepté dans `labfactory-dev`. Deployment `labfactory-windows-pool-worker` : `npm run windows-pool-worker`, secrets base de données/Redis/Proxmox, `labfactory-config`, `RollingUpdate` (réplicas coordonnés par PostgreSQL), `terminationGracePeriodSeconds: 150` (attente des opérations en cours, aucune tâche Proxmox interrompue), 100m/256Mi → 1 CPU/512Mi.
- [x] **Déployé en dev le 2026-11-20** (accord utilisateur, étape 1) : branche rebasée sur `origin/main` (après le commit CI `8560f14` des images `4e7e0b7`), présence du worker vérifiée dans l’image `worker-4e7e0b7`, rendu prod identique à `origin/main`, poussée en avance rapide sur GitOps `main` (`8560f14..e8ba6f0`). ArgoCD : `labfactory-windows-pool-worker` `Running`, 0 redémarrage, heartbeat Redis `worker:windows-pool = running`, aucun bail ni VM (pool en pause, aucun template). Incident sans suite : un premier `git fetch` GitLab est resté bloqué (probable invite d’identifiants invisible), le second a abouti.
- [x] ~~Ne pas fusionner avant une image dev contenant `feature/windows-pool-p1`~~ : ArgoCD dev suit `HEAD` en synchronisation automatique ; l’image dev actuelle (`worker-c02df67`) ne contient pas le worker du pool (CrashLoop). Le clone local était en retard de 108 commits (mises à jour d’images poussées par la CI) : avancé en fast-forward avant la branche.

### Implémentation P2 (simulée, 2026-11-20)

Fichiers : `lib/windowsPool/proxmox.js` (client HTTP, `waitTask` sans annulation, `guestRun` QGA), `lib/windowsPool/manager.js` (boucle de gestion), `workers/startWindowsPoolWorkerService.js`, `package.json` (script), migration 032 complétée par `windows_pool_settings.proxmox_pool` (jamais appliquée hors schémas de test, modifiée en place).

Fonctionnement par tick (5 s, `WINDOWS_POOL_TICK_MS`) : réconciliation des baux orphelins → vidange des VM prêtes d’une ancienne révision → avancement de chaque VM `creating`/`preparing`/`deleting` (chaîne indépendante, verrou consultatif `pool-vm:<id>` partagé entre réplicas, version optimiste) → réapprovisionnement (`planReplenishment`). Rien n’attend la VM la plus lente ; attentes et backoffs = date de prochain passage en checkpoint, sans créneau ni verrou tenu.

- **Création** : bail `clone` (cluster/nœud/stockage) → allocation VMID (contrôle 3 sources) → re-contrôle juste avant le clone → `clone` **linked** (`full=0`, `target`, pool Proxmox, description `labfactory-pool:<id>`) → UPID en checkpoint et rattaché au bail → configuration avant premier boot (`onboot=0`, `configdrive2`, `ipconfig0=ip=dhcp`, compte selon langue — `Administrateur` pour `fr` —, mot de passe provisoire aléatoire jamais stocké, tag `labfactory-pool`, **toutes les NIC `link_down=1` relues**) → entrée en préparation sous budget global `prepare` compté sur les VM `preparing` en base (résistant aux crashs).
- **Préparation** : à chaque passage, relecture propriété + `link_down` (sinon quarantaine `NIC_CONNECTED`), démarrage si nécessaire, sonde QGA sous bail `guest_probe` court, écriture du marqueur (désactive Cloudbase-Init), `ready` seulement sur verdict `READY` ; suppression du `cipassword` de la config Proxmox ; `pg_notify('windows_pool_stock')`. Délai dépassé → `PREPARATION_TIMEOUT`.
- **Destruction** : VM absente → `deleted` ; VM sans le marqueur → `deleted` **sans aucune action Proxmox** (`VMID_FOREIGN`) ; sinon arrêt + `DELETE purge`.
- **Reprise** : UPID connu → attente de la même tâche (jamais de second clone) ; tâche échouée → UPID oublié, VMID re-contrôlé ; VM retrouvée avec notre marqueur → adoptée comme clonée. Erreurs transitoires (`cfs-lock`…) → backoff ; 6 échecs → quarantaine `REPEATED_FAILURE`.

### Qualification P2 sur infrastructure réelle — 2026-11-20 — **réussie**

Harnais jetable `tmp/p2-qualify.mjs` : manager réel + Proxmox réel + schéma isolé dans la base `labfactory-dev` (via `kubectl port-forward`), template 147 → `peda-pve2`/`ceph-pool`, pool Proxmox `labs-dev`, réserve 2 / plafond 3. Rapport : `output/p2-2026-11-20T10-08-58-481Z.json`.

- **Première tentative (09:56) arrêtée, aucune VM créée** : la liste complète de `ceph-pool` (1910 volumes) prend ~30 s, limite du proxy Proxmox (HTTP 596), et échouait pendant un déploiement concurrent (clones du template 148). Le contrôle « fail closed » refusait donc tout VMID. **Correctif** : interrogation ciblée des noms de volumes qu’un clone créerait (`vm-N-disk-0..3`, `vm-N-cloudinit`) — un volume absent répond en < 300 ms ; stockage injoignable → `VOLUME_CHECK_UNAVAILABLE`, allocation reportée sans quarantaine ni VMID consommé.
- **Seconde tentative (10:08) : 2 VM prêtes (70000, 70001)**, clones linked lancés à 1 s d’écart (plafond clone 2), préparations chevauchées sur 399 s ; création → prête en **6 min 43 s** et **6 min 50 s** (préparation seule 402 s / 410 s). Séquence QGA observée : `AGENT_UNAVAILABLE` → `SETUP_IN_PROGRESS` → `AGENT_UNAVAILABLE` (reboot OOBE) → `CLOUDBASE_RUNNING` → marqueur écrit → `ready`.
- Vérifié sur Proxmox pour chaque VM : VMID dans la plage, `scsi0 = ceph-pool:base-147-disk-1/vm-N-disk-1` (linked clone), `link_down=1` toujours présent, `cipassword` retiré, marqueur `labfactory-pool:<id>`, membre de `labs-dev`, en marche.
- Changement de révision (réserve 0) : 2 VM vidangées puis **détruites en 1 min 46 s** ; aucun bail résiduel. Après coup : aucun guest dans 70000–79999, VMID 70000/70001 de nouveau libres (registre, inventaire, volumes), schéma de test supprimé.
- Non couvert ici (couvert par les tests simulés) : quarantaine, VM étrangère, reprise après crash, délai de préparation, stockage indisponible.

Tests `tests/windowsPool.manager.test.js` (PostgreSQL réel en schéma isolé + Proxmox simulé), **9/9, stables sur 3 exécutions** (dont stockage indisponible : allocation reportée sans quarantaine puis reprise) : réapprovisionnement à la réserve en linked clones isolés avant boot (VMID caché et disque orphelin évités, plafond clone 2 atteint sans dépassement, préparations simultanées, mot de passe provisoire retiré, aucun bail résiduel, stabilité) ; demande au-delà de la réserve jusqu’au plafond ; quarantaine sur erreurs bootstrap et NIC reconnectée ; VM étrangère jamais touchée ; reprise après crash sans second clone ; nouvelle révision vidangée/détruite/remplacée ; délai de préparation.

## P3 — Réservation et attente

- [x] Calculer les besoins par template/révision et réserver toutes les Windows d’un lab dans une transaction courte.
- [x] En pénurie : ne réserver aucun lot partiel, enregistrer `waiting_for_pool`, différer sans consommer une tentative ou conserver un worker/verrou.
- [x] Réveiller les demandes lors de l’arrivée de stock, avec réconciliation périodique de secours.
- [x] Prévenir la famine des gros labs et les doubles affectations entre workers.
- [x] Vérifier qu’un lab en attente n’empêche ni d’autres labs indépendants de progresser, ni le pool de se remplir.
- [x] Distinguer réserve et plafond : une demande supérieure à la réserve doit pouvoir déclencher une préparation suffisante.
- [x] Afficher un blocage explicite si le plafond ou la suspension du pool empêche la satisfaction de la demande ; aucun clonage direct. (Motif stocké dans `blocked_reason` et publié dans la progression du job ; affichage dans l’interface = P6.)
- [x] Permettre l’annulation et libérer uniquement les réservations intactes et revérifiées.
- [ ] Brancher la création de demande et l’attente dans le parcours deploy/redeploy — **reporté à P4** : réserver sans affecter casserait les labs actuels (Windows encore clonées par Terraform).

### Implémentation P3 (2026-11-20)

Fichiers : `lib/windowsPool/coordinator.js`, `lib/windowsPool/waiting.js`, `lib/windowsPool/cancellation.js`, `lib/windowsPool/reservation.js` (correctif FIFO + notification à la création), `workers/startWindowsPoolWorkerService.js` (coordinateur branché), `tests/helpers/windowsPoolFakeProxmox.js` (Proxmox simulé partagé), `tests/windowsPool.reservation.test.js`.

- **Coordinateur** (dans le worker du pool) : parcourt les demandes en attente par ancienneté ; réveillé par `LISTEN windows_pool_stock` (VM prête) et `windows_pool_requests` (demande créée, notifiée au commit) ; réconciliation de secours à chaque tick ; écoute rétablie automatiquement si la connexion tombe ; passes fusionnées (une seule à la fois). Plusieurs réplicas possibles.
- **Correctif P1 (blocage en tête de file)** : une demande qui ne peut pas être servie pour une autre raison que le stock (`DEMAND_EXCEEDS_CAPACITY`, `TEMPLATE_DISABLED`) ne bloque plus les demandes plus récentes du même template ; elle retrouve son rang dès que la cause est levée. Le FIFO reste strict pour l’attente de stock (pas de famine des gros labs).
- **Attente côté job** (`awaitPoolReservation`) : `reserved` → VM retournées ; en attente → motif publié dans la progression du job, `moveToDelayed` + `DelayedError` (ni tentative ni créneau consommés, aucun verrou à tenir) ; demande close → `PoolRequestClosedError`, jamais de clonage direct. `promoteDeploymentJob` réveille immédiatement le job retardé du lab dès la réservation (hook du coordinateur, file `terraform-workflows`).
- **Annulation vérifiée** (`cancelPoolRequestVerified`) : chaque VM réservée est contrôlée en parallèle — présente, marqueur de propriété, sans verrou, allumée, toutes NIC `link_down=1`, verdict QGA complet `READY` (marqueur lié à la VM et à la révision). Seules les VM prouvées intactes reviennent en `ready` ; les autres (et toute VM déjà `configuring`) passent en `deleting` et sont détruites par le gestionnaire.
- **Contrat pour P4** : le job doit libérer ses verrous avant `awaitPoolReservation` ; une annulation peut survenir pendant l’affectation — le job doit revérifier le statut de la demande avant chaque étape de mutation.

Tests `tests/windowsPool.reservation.test.js` (PostgreSQL réel en schéma isolé + Proxmox simulé), **6/6** : pool vide → attente explicite → préparation déclenchée par la demande → réservation par la seule notification ; lab en attente sans effet sur un lab indépendant ni sur le réapprovisionnement ; tête de file (demande impossible, template désactivé) ; attente BullMQ (progression, `moveToDelayed`, promotion, VM retournées, demande close) ; annulation vérifiée (1 intacte libérée, NIC reconnectée et marqueur erroné détruits) ; 3 coordinateurs concurrents sans double réservation. Ensemble des suites pool + `jobConcurrency` : **60/60 sur 2 exécutions**. Le démarrage du worker complet (Redis + LISTEN) n’a pas été exécuté localement (pas de Redis local) : contrôle syntaxique seulement.

## P4 — Affectation et customizations

### Cartographie du parcours actuel (2026-11-20, lecture seule)

- **VMID jamais persistés** : `buildTerraformDeploymentPayload` (`dashboard/server.js` ~1379) les recalcule (`10000 + (hash(uuid) % 5000) * 10 + index`) pour deploy, statut, start/stop, reset IP/mot de passe, redeploy, destroy. Seule donnée par VM persistée : `lab_deployments.workstation_passwords`.
- **Deploy** : `POST /api/lifecycle/deployments/:id/deploy` → statut `queued` → job `apply` (file `terraform-workflows`) → `acquireJobLocks` (`lab:<id>` + `global:terraform-deploy`) → vars → plan/préflight VMID/apply → readiness WinRM/SSH (`waitForGuestReadiness`) → job Ansible `customize-timezone` (`customizing`) ou `deployed`.
- **`global:terraform-deploy` tenu jusqu’à la fin du job Terraform, readiness incluse** : les déploiements de labs sont sérialisés à l’échelle du cluster pendant les attentes WinRM/SSH.
- **Lab 100 % Windows** : liste `vm_definitions` vide → `terraform/main.tf` planifie une VM de repli (`labfactory-empty-vm`, VMID 150). À ne jamais déclencher.
- **Réseau** : `ipconfig0` statique (`buildCloudInitIpConfig`, masque /24–/30, passerelle calculée) ou `ip=dhcp` si `ipLastOctet` absent ; VLAN = `startingVlan (+ index du poste)`. **Aucun DNS passé par Terraform** (P2 : métadonnées cloud-init avec DNS du nœud `10.1.0.20/21`, `emfnet.ch`) ; le reset IP impose `195.186.4.162/163` et choisit la NIC `Up`.
- **Mots de passe** : `shared` (blueprint) ou `per-workstation` (`workstation_passwords`) ; `cipassword` par VM ; Ansible utilise le mot de passe par cible, **sauf les blocs de tâches qui reçoivent toujours le mot de passe partagé** (`lib/runCustomization.js:126`, écart existant à signaler).
- **Redeploy d’un poste** : `replaceVmids` → `terraform -replace/-target`, readiness et customization limitées au poste.
- **Destroy** : `terraform destroy` puis **suppression de la ligne `lab_deployments`** (`removeDestroyedDeployment`) — bloquée par les FK `RESTRICT` du pool tant que P5 n’adapte pas ce chemin.

### Plan P4 proposé (à valider)

Principe : **tout le nouveau parcours est derrière un mode** (`windows_pool_settings`, défaut = parcours historique inchangé). P4 et P5 sont développés avant toute activation ; aucun lab existant ne change de comportement tant que le mode n’est pas activé.

1. **P4a — Module d’affectation** (`lib/windowsPool/assignment.js`), une chaîne par VM, sans verrou global : renommage/tags/description lab (marqueur conservé) → ressources/disque additionnel, avec redémarrage **réseau toujours coupé** si nécessaire → bridge/VLAN Proxmox → IP/préfixe/passerelle/DNS + mot de passe final via QGA (stdin) → vérification lien coupé → connexion → vérification post-connexion (1 IPv4 `Preferred`) → WinRM depuis le worker. Transitions `reserved → configuring → assigned`, ligne `lab_vm_assignments`. Revérification du statut de la demande avant chaque mutation (annulation). Mode DHCP pris en charge (`ipLastOctet` absent). Tests simulés + qualification réelle (1 VM du pool affectée à un poste A43 de test).
2. **P4b — Branchement deploy/redeploy** (`dashboard/server.js`, `workers/terraformWorker.js`) : plan des emplacements (Linux → Terraform, Windows → pool) ; création de la demande ; attente `awaitPoolReservation` **avant** de prendre les verrous (statut lab `waiting_for_pool`, ajouté aux statuts occupés) ; Terraform limité aux VM Linux et **sauté s’il n’y en a aucune** ; affectations Windows en parallèle de Terraform ; readiness Linux inchangée ; transmission à Ansible avec les VMID réels des affectations. Redeploy d’un poste du pool : réserver les remplaçantes avant de libérer les anciennes (ancienne VM → `deleting`).
3. **P4c — Réduction de `global:terraform-deploy`** au seul plan/apply (pas les attentes readiness), avec tests de non-régression sur les labs historiques et les collisions VMID.
4. **P4d — Customizations par graphe de dépendances** (`dependencies.js` + baux `customize`) : suppression de l’enchaînement Linux puis Windows et des limites codées à 5, barrières métier conservées (contrôleur avant membres par domaine/réseau, aucune injection de panne après échec de préparation) ; correction de l’écart de mot de passe des blocs de tâches à décider séparément.
5. **Puis P5** (statut, start/stop, reset, destroy, propriétaire, exports lisant `lab_vm_assignments`) avant toute activation.

### P4a — Module d’affectation (2026-11-20, simulé)

Fichiers : `lib/windowsPool/assignment.js` (`createPoolAssigner`), `lib/windowsPool/qga.js` (mode DHCP), migration 032 (`dns_servers`), `tests/helpers/windowsPoolFakeProxmox.js` (réseau invité, reboot, journal d’ordre), `tests/windowsPool.assignment.test.js`.

- Chaîne par VM sous verrou `pool-vm:<id>` et bail `assign` : configuration Proxmox (nom, tags `labfactory-pool;<enseignant>`, description avec marqueur conservé, VLAN sur `net0`, autres NIC inchangées, cœurs/mémoire avec **reboot réseau coupé** puis re-vérification QGA, disque additionnel marqué `serial=lf-disk2` pour l’idempotence) → réseau invité (statique ou DHCP) + mot de passe final par stdin, vérifié lien coupé → statut de la demande revérifié → connexion → contrôle post-connexion → WinRM (fonction injectée) → statut revérifié → `assigned` + ligne `lab_vm_assignments` dans la même transaction.
- Échec après le début de la configuration : NIC re-déconnectée, VM en quarantaine avec le code de l’étape, erreur remontée (l’emplacement doit recevoir une nouvelle VM). VM réservée non encore touchée (demande annulée avant le début) : laissée intacte. Reprise : étapes idempotentes, VM déjà `assigned` pour la même demande → retour de l’affectation existante.
- Tests simulés **9/9 ×3** : ordre réseau invité (lien coupé) → connexion → contrôle ; mot de passe jamais en ligne de commande ; ressources + disque (reboot NIC coupée, disque ajouté une fois) ; DHCP ; conflit IP → quarantaine + NIC recoupée ; défaut DHCP P0 détecté avant connexion ; WinRM indisponible ; annulation ; 3 VM en parallèle sous plafond `assign` 2. Suite complète 60/60.
- **Qualification réelle réussie (2026-11-20, 11:41–11:51 CET)** — harnais `tmp/p4a-qualify.mjs`, rapport `output/p4a-2026-11-20T10-41-51-280Z.json` : demande sur pool vide → `INSUFFICIENT_STOCK` → préparation déclenchée par la demande → VM 70000 réservée après **6 min 43 s** → affectation au poste de test A43 (VLAN 72, `10.10.72.121/25`, passerelle `.1`, DNS `195.186.4.162/163`, mot de passe aléatoire non conservé) en **52 s**. Vérifié : nom Proxmox, `tag=72` + `link_down=0`, marqueur conservé, état `assigned` + affectation enregistrée ; côté invité 1 seule IPv4 `Preferred` /25, DHCP désactivé, passerelle et DNS exacts, Cloudbase-Init désactivé ; **après reboot** : configuration réseau identique et **WinRM OK avec le même mot de passe** (depuis `labfactory-ansible-worker` dev). VM détruite par le gestionnaire (contrôle de propriété), aucun guest restant dans 70000–79999, schéma supprimé.
- **Reste pour P4a** : implémentation de production du contrôle WinRM (dans le worker, sans `kubectl exec`) — à faire avec P4b.

### P4b — Branchement deploy (2026-11-20, simulé, non activé)

Fichiers : `lib/windowsPool/deployment.js` (classification, demande par run, créneaux, exécution parallèle, clôture), `workers/terraformWorker.js` (3 points d’entrée `preparePoolDeployment`, `startPoolAssignments`, `settlePoolAssignments` + contrôle WinRM `checkPoolVmWinrm`), `dashboard/server.js` (`templateId` dans le payload, statut `waiting_for_pool` occupé/transitoire), `dashboard/public/app.js` (libellé « Waiting for Windows pool »), migration 032 (`windows_pool_requests.run_id`), `tests/windowsPool.deployment.test.js`, `tests/jobConcurrency.test.js` (stubs).

- **Classification** : VM Windows dont le template est activé dans le pool → pool ; tout le reste → Terraform, inchangé. Aucun template activé ⇒ `preparePoolDeployment` retourne `null` et le parcours historique est strictement identique (vérifié par la suite existante).
- **Attente avant verrous** : demande liée au run (`run_id`, reprise du job retardé sans doublon ; demande d’un run abandonné annulée avec vérification) ; statut lab `waiting_for_pool` ; `awaitPoolReservation` (ni tentative, ni créneau, ni verrou).
- **Terraform** limité aux VM non-pool ; **sauté entièrement** si le lab n’a que des VM du pool (jamais la VM de repli de `main.tf`) ; `global:terraform-deploy` pris seulement si Terraform a des VM.
- **Affectations en parallèle de Terraform** (chaînes démarrées avant `terraform init`, bornées par les baux `assign`) ; réseau calculé par `buildCloudInitIpConfig` (règles identiques à Terraform) ; DNS de `windows_pool_settings` ; mot de passe par poste ou partagé, compte selon la langue ; disque additionnel sur le stockage du template.
- **Readiness** : VM du pool exclues de la readiness Cloudbase-Init (le `done.flag` précède le boot courant) — leur readiness est l’affectation réussie (contrôles QGA + `win_ping` WinRM depuis le worker, même limite de readiness) ; VMID et IP réels transmis à Ansible.
- **Échec d’une affectation** : lab `failed` (comme un échec de readiness), demande `failed` ; si Terraform échoue pendant les affectations, le job attend leur fin avant de libérer ses verrous.
- **Redeploy** d’un poste servi par le pool : refusé explicitement (`POOL_REDEPLOY_UNSUPPORTED`, séquence de remplacement = P5) ; redeploy d’un poste historique inchangé, sans jamais inclure les emplacements du pool dans Terraform.
- Tests : `tests/windowsPool.deployment.test.js` **8/8 ×2** (classification, demande par run, créneaux, bout en bout réservation → affectations parallèles → demande `fulfilled` → payload Ansible avec VMID/IP réels, redeploy) ; suite complète du dépôt avec base : **226 réussis, 0 échec** (8 ignorés : Docker/HTTP).
- **Ne pas activer de template avant P5** : le destroy (`terraform destroy` + suppression de la ligne `lab_deployments`) ignore les VM du pool et sera bloqué par la FK `RESTRICT` des affectations ; statut/start/stop/reset recalculent encore les VMID. Non validé de bout en bout sur le cluster (nécessite le déploiement des images dev). La progression readiness de l’interface ne suit pas encore les VM du pool (P6).

### P4c — Réduction de `global:terraform-deploy` (2026-11-20)

- **Audit** : le verrou protège la cohérence entre le préflight VMID (`checkPlannedVmids`) et `terraform apply` d’un lab vis-à-vis des créations des autres labs (VMID calculés `10000 + (hash % 5000) * 10 + index` pouvant se chevaucher entre labs ; contention Ceph `cfs-lock`). Il n’a aucune utilité pendant la readiness WinRM/SSH, les affectations du pool ni la remise à Ansible, qu’il couvrait jusqu’ici (sérialisation des déploiements de tout le cluster pendant des dizaines de minutes).
- **Changement** : `tryJobLocks` expose `releaseKey(key)` (`pg_advisory_unlock` sur la même session, idempotent) et `holds(key)` ; le worker libère `global:terraform-deploy` **juste après `apply`** (y compris après les reprises `cfs-lock`). Plan, préflight et apply restent couverts ; `lab:<id>` reste tenu jusqu’à la fin du job (pas d’opérations contradictoires sur un même lab). Destroy, start, stop : inchangés (ne prenaient pas le verrou global). Labs 100 % pool : verrou global jamais pris (P4b).
- **Validation** : tests `jobConcurrency` 14/14 (nouveau test `releaseKey` ; dans le processeur réel en bac à sable, readiness exécutée **hors verrou global et sous verrou du lab**, tous verrous libérés en fin de job) ; suite complète 186 réussis / 0 échec ; comportement vérifié sur **PostgreSQL réel** (dev, clés `p4c-test:*`) : libération d’une seule clé, l’autre conservée, session toujours valide.
- **Effet attendu** : plusieurs labs peuvent enchaîner leurs créations Terraform pendant que les précédents attendent leur readiness ; à mesurer sur le cluster (P6), sans supposer de gain linéaire (charge Proxmox/Ceph).

### P4d — Customizations par dépendances (2026-11-20)

Fichiers : `lib/runCustomization.js` (réécriture de l’orchestration), `lib/windowsPool/dependencies.js` (`domainControllersFor`, règle unique domaine + réseau /24), `lib/windowsPool/leases.js` (`createLeaseLimiter`), `workers/ansibleWorker.js` (budget distribué `customize`), migration 032 (budget `customize` = 10), `tests/customizationScheduling.test.js`, `tests/windowsPool.db.test.js`.

- **Avant** : validations des blocs une par une ; toutes les Linux **puis** toutes les Windows ; tous les contrôleurs du lab **puis** tous les membres ; injection de panne ; limite 5 codée en dur par job (soit au plus 10 commandes en tout : 1 réplica × 2 jobs).
- **Après** : validations en parallèle ; une chaîne par VM démarrée immédiatement (Linux et Windows en parallèle ; setup → fichiers → reboot → reconnexion dans l’ordre pour chaque VM) ; un membre attend **seulement** le(s) contrôleur(s) de son domaine sur son réseau ; blocs de tâches en parallèle entre VM, dans l’ordre pour une même VM. Seules les commandes Ansible tiennent un créneau (attentes de reconnexion, backoffs, attente du contrôleur : aucun). Créneaux = budget distribué `customize` (PostgreSQL, partagé entre réplicas et labs, renouvelé pendant les longues commandes), **10 par défaut = maximum actuel**, repli local `CUSTOMIZATION_CONCURRENCY` (5) si la migration manque.
- **Barrières métier conservées à l’identique** : toutes les validations réussies avant toute mutation (désormais toutes les validations en échec sont enregistrées, pas seulement la première) ; aucune injection de panne si une préparation ou une readiness a échoué ; un membre tente toujours sa jonction une fois son contrôleur terminé, même en échec (sémantique historique, seul le périmètre d’attente est réduit). Checkpoints et reprise inchangés.
- **Preuves** : `tests/customizationScheduling.test.js` 7/7 ; exécutés contre l’**ancienne** orchestration, les 4 tests de parallélisme **échouent** (Linux/Windows, domaine par réseau, validations parallèles, créneaux non tenus pendant les attentes) et les 3 tests de barrières passent : la sémantique est conservée, seule la sérialisation inutile disparaît. Budget `customize` : 2 réplicas, plafond 3 jamais dépassé (PostgreSQL réel). Suite complète avec base : **235 réussis, 0 échec, ×3**.
- **Mots de passe des blocs de tâches — corrigé sur demande de l’utilisateur (2026-11-20)**. Diagnostic : les exécuteurs (Docker et Kubernetes) prenaient déjà le mot de passe de la cible avant le partagé, mais avec la règle `target.windowsAdminPassword ?? partagé`, qui **ne retombe pas sur le partagé pour une chaîne vide** ; or le worker Terraform construit les cibles avec `String(... ?? '')`. Selon l’endroit, une cible à mot de passe vide donnait un bloc exécuté **avec un mot de passe vide**, une readiness WinRM avec un mot de passe vide, ou un faux « mot de passe requis » à l’inventaire Ansible. Correction : règle unique `guestPasswordFor(target, partagé)` (`lib/ansibleTasks.js` : mot de passe propre s’il est non vide, sinon partagé), utilisée par `runAnsibleTasks.js` (inventaire, exécution, masquage), `runCustomization.js` (qui passe désormais explicitement le mot de passe de la VM aux blocs), `workers/ansibleWorker.js` (inventaires et contrôles) ; même correction dans la readiness de `workers/terraformWorker.js`. Tests : règle, inventaire Windows/Linux, et mot de passe reçu par chaque bloc (par poste, et repli sur le partagé si vide) ; suite complète 195 réussis / 0 échec.
- S’applique à **tous** les labs dès le déploiement (comme P4c).

**Décision utilisateur (2026-11-20, pendant P6) — surplus du stock détruit** : désactiver un template détruit ses VM prêtes ; abaisser sa réserve détruit le surplus de VM prêtes au-delà de (réserve + demande des labs en attente), en gardant les plus récentes. Jamais touchées : VM réservées/affectées (labs) et préparations en cours (traitées une fois prêtes). Sélection `FOR UPDATE SKIP LOCKED` (jamais une VM en cours de réservation). La suspension globale (`paused`) conserve le stock. Code `STOCK_SURPLUS` dans le journal des VM. Tests : `tests/windowsPool.trim.test.js` (3 scénarios) ; suite 261/0.

**Décision utilisateur (2026-11-20, pendant P6) — pools Proxmox séparés** : les VM du stock du pool (en préparation, prêtes, réservées) sont dans un pool Proxmox dédié : **`pool` en prod, `pool-dev` en dev** (`windows_pool_settings.proxmox_pool`, modifiable dans la page P6). À l’affectation à un lab, la VM est déplacée (réseau encore coupé, `PUT /pools` avec `allow-move`) dans le pool Proxmox des labs (`vm_pool` des réglages Terraform : `labs` / `labs-dev`), comme les VM clonées par Terraform. Le pool Proxmox `pool-dev` a été créé et configuré en dev le 2026-11-20 ; **`pool` (prod) reste à créer lors de l’activation en prod**. Tests : affectation (déplacement `pool-dev` → `labs-dev` avant toute mise en réseau) et déploiement de bout en bout ; suite 255/0.

**Décisions utilisateur (2026-11-20)** :
- **Transition par template** : un template Windows activé et qualifié dans le pool passe par le pool ; les autres restent sur Terraform jusqu’à leur qualification. Pour un template activé, aucun repli : stock insuffisant ⇒ le lab attend. (Remplace l’idée de mode global : le « mode » est `windows_pool_templates.enabled`, plus `windows_pool_settings.paused`.)
- **DNS des Windows affectées : `195.186.4.162`, `195.186.4.163`** (valeurs du reset IP actuel), stockés dans `windows_pool_settings.dns_servers` (modifiable sans déploiement).

- [x] Persister les VMID attribués et utiliser ces identités dans tous les payloads (affectations `lab_vm_assignments`, VMID réels transmis à readiness/Ansible ; lecture par statut/start/stop/reset = P5).
- [x] Appliquer nom, tags, ressources et disques ; gérer les éventuels redémarrages avant connexion réseau.
- [x] Configurer bridge/VLAN, puis IP/DNS et identifiants via QGA en conservant NIC et MAC.
- [x] Vérifier par QGA avant de reconnecter, puis vérifier WinRM depuis le worker.
- [x] Réutiliser les customizations existantes et leurs dépendances, notamment contrôleurs de domaine avant membres.
- [x] Exécuter en parallèle les chaînes d’affectation des VM et les branches Linux/Windows d’un lab mixte après réservation ; ne pas attendre toutes les VM avant une étape indépendante.
- [x] Revoir les barrières globales et le traitement Linux puis Windows dans les customizations ; conserver les barrières métier justifiées et ordonner les dépendances AD par poste/réseau/domaine.
- [x] Paralléliser les validations indépendantes des blocs Ansible tout en conservant la barrière « toutes les validations réussies avant mutation » ; remplacer les limites locales codées en dur par les budgets configurables définis en P1.
- [x] Exclure toute création Windows des plans Terraform ; ne pas lancer le repli Terraform avec une liste vide pour un lab 100 % Windows (Windows des templates activés uniquement ; les autres restent sur Terraform, décision de transition par template).
- [x] Validation de bout en bout sur le cluster dev (2026-11-20) : deploy, redeploy de poste, stop et destroy d’un lab réel depuis le dashboard — voir le journal.

## P5 — Cycle de vie et compatibilité

- [x] Utiliser les affectations réelles pour affichage, statut, start/stop, snapshots, reset IP/mot de passe, propriétaire, exports et customizations.
- [x] Réserver les remplaçantes avant suppression des anciennes Windows lors d’un redéploiement de poste.
- [x] Terminer la destruction d’un lab seulement après succès de tous ses gestionnaires ; conserver les informations nécessaires en cas d’échec partiel.
- [x] Reprendre chaque opération sur la même affectation après crash ; ne pas libérer aveuglément une réservation expirée.
- [x] Vérifier l’identité de propriété avant toute opération sensible (reset IP/mot de passe, pause des mises à jour, snapshots, retrait avant remplacement, destruction ; start/stop : VMID issus du plan effectif, sans relecture du marqueur — à renforcer en P6 si souhaité).
- [x] Paralléliser les opérations de cycle de vie sur VM indépendantes, agréger tous les résultats et reprendre uniquement les opérations incomplètes après échec partiel (destroy Terraform ∥ pool ; start/stop existants déjà parallèles).
- [x] Conserver la gestion historique des VM existantes sans retrait implicite de leur état Terraform.
- [x] Adapter les remplacements historiques pour que toute nouvelle Windows passe par le pool.
- [x] Auditer les éventuelles VM laissées par l’ancien pool, sans adoption ou suppression automatique.

### Implémentation P5 (2026-11-20, simulé, non activé)

Fichiers : `lib/windowsPool/deployment.js` (`fetchActiveAssignments`, `overlayAssignments`, `terraformManagedVms`, `teardownDeploymentPool`, `purgeDeploymentPoolRecords`, `retireReplacedVms`, classification de redeploy), `lib/windowsPool/assignment.js` (remplacement dans la transaction d’enregistrement), `dashboard/server.js`, `workers/terraformWorker.js`, tests `windowsPool.deployment.test.js`, `windowsPool.redeploy.test.js`, `vmSnapshots.api.test.js`, stubs de tests du dashboard.

- **Plan effectif unique** : `buildEffectiveDeploymentPayload` (plan calculé + affectations actives : VMID réel, `manager: 'windows-pool'`, `poolVmId`) remplace les 11 appels de `buildTerraformDeploymentPayload` (liste et réconciliation des statuts, propriétaire, start/stop/destroy/deploy, redeploy, snapshots, reset IP/mot de passe, pause des mises à jour). Sans affectation (labs historiques, migration absente) : plan inchangé.
- **Propriété** : `checkPoolVmOwnership` relit le marqueur `labfactory-pool:<id>` avant snapshot, reset IP, reset mot de passe, pause des mises à jour → `409` sinon.
- **Terraform** n’a jamais les VM du pool dans ses définitions, quelle que soit l’action (deploy, destroy, redeploy).
- **Destroy** : Terraform et pool en parallèle ; côté pool, demandes ouvertes annulées (VM intactes rendues au stock), affectations closes, VM du lab → `deleting` (détruites par le gestionnaire après contrôle du marqueur), attente, purge des lignes ; la ligne du lab n’est supprimée qu’après succès des deux. Échec/délai (ex. worker du pool arrêté) : lab `failed`, informations conservées, suppression bloquée par les FK. Suppression de la fiche d’un lab : refusée (`409`) tant que des VM du pool vivent, sinon lignes du pool purgées.
- **Redeploy de poste** : emplacement servi par le pool → nouvelle demande `redeploy-workstation` réservée **avant** toute suppression ; puis anciennes VM coupées (`link_down=1`) et arrêtées (marqueur vérifié) **avant** la connexion de la nouvelle (même IP) ; à l’enregistrement, ancienne affectation `replaced` + ancienne VM `deleting` dans la même transaction (historique `replaces_assignment_id`). Windows historique dont le template est désormais activé → VM du pool, l’ancienne coupée puis détruite par Terraform (ciblée, absente de la config). Terraform ne cible que ses propres VM ; **aucune cible ⇒ Terraform sauté** (un plan sans `-target` toucherait tout le lab).
- **Audit ancien pool (dev, 2026-11-20, lecture seule)** : migrations 025–028 appliquées le 2026-10-20, retirées par 029 le 2026-10-21 ; table `vm_pool` absente ; aucun guest ≥ 900000 (plage de l’ancien pool), aucun nom/tag « pool » sur 464 guests. **Production non auditée.**
- Tests : déploiement 11/11 (plan effectif, destroy complet, destroy sans worker), redeploy 5/5 ×2 (remplacement réservé avant, ancienne coupée avant connexion de la nouvelle, historique Windows → pool, propriété perdue), snapshot refusé sans marqueur ; suite complète avec base **246 réussis / 0 échec ×2**.
- **Reste** : validation de bout en bout sur le cluster (images dev, worker du pool déployé, template activé) ; manifeste Kubernetes du worker du pool ; audit production.

## P6 — Interface, supervision et activation

- [x] Ajouter configuration et compteurs par template : prêtes, en préparation, réservées, en erreur.
- [x] Afficher les besoins manquants et permettre l’annulation des labs en attente.
- [x] Adapter états occupés, récupération des jobs et reconstruction des statuts pour ne pas déclarer détruit un lab en attente.
- [~] Mesurer attente du pool, intégration réseau, customization et délai total utilisateur séparément — fait : préparation, attente du pool (toutes / stock vide séparées), affectation réseau ; **reste** : customization et délai total utilisateur dans la page (la durée totale de déploiement existe déjà dans `blueprint_deployment_durations`).
- [~] Exposer opérations actives/en attente par catégorie, temps d’attente des limites/verrous et chronologie par VM ; comparer les durées avec pool prêt et pool vide sans confondre les deux scénarios — fait : baux actifs par catégorie/portée (dont tâches Proxmox en cours), chronologie par VM, attente avec stock prêt vs vide séparée ; **reste** : temps d’attente des limites/verrous (non mesuré).
- [x] Qualifier chaque template avant activation et documenter le dimensionnement (qualification par révision obligatoire, appliquée par la base ; mesures P0/P2/dev consignées dans ce document).
- [x] Prévoir une suspension contrôlée : arrêter les nouvelles affectations sans repli direct ni impact sur les labs existants (`paused` global ou template désactivé : réservations bloquées `POOL_PAUSED`/`TEMPLATE_DISABLED`, aucun réapprovisionnement ; affectations en place, destructions et labs existants inchangés).

### Implémentation P6 (2026-11-20, branche `feature/windows-pool-p6`, non poussée)

Fichiers : `db/migrations/033-windows-pool-qualification.sql`, `lib/windowsPool/admin.js`, `dashboard/server.js` (routes `/api/windows-pool*`, annulation `cancel-pool-wait`, « Cancel all jobs »), `dashboard/public/windowsPool.js` (page), `dashboard/public/index.html`, `dashboard/public/app.js` (titre, événement de vue, action « Cancel » d’un lab en attente), `dashboard/public/styles.css`, tests `windowsPool.admin.test.js` (6/6, PostgreSQL), `windowsPool.ui.test.js` (3/3, jsdom), `dashboardUx.api.test.js` (stubs).

- **Qualification obligatoire avant activation** (migration 033) : `qualified_revision` doit égaler `revision` pour `enabled = true`, contrainte en base (même une mise à jour SQL directe est refusée). Changer le template Proxmox source crée une nouvelle révision, désactive le template et exige une nouvelle qualification.
- **API admin** (`ADMIN_ONLY`) : vue d’ensemble (réglages, templates Windows + compteurs par état, labs en attente avec motif et VM manquantes, limites et baux actifs dont tâches Proxmox, quarantaines, mesures sur 7 jours : préparation, attente du pool — toutes / stock vide séparées —, affectation réseau), réglages (suspension, pool Proxmox, DNS ; plage VMID non modifiable), configuration/qualification/activation d’un template, plafonds par catégorie et portée, destruction d’une VM en quarantaine (jamais rendue au stock), chronologie d’une VM.
- **Labs** : `POST /api/lifecycle/deployments/:id/cancel-pool-wait` (propriétaire ou admin, lab `waiting_for_pool`) : job retardé supprimé, demande annulée (VM intactes rendues au stock), lab `failed/cancelled` ; bouton « Cancel (waiting for Windows pool) » dans la liste des labs. « Cancel all jobs » ferme désormais les demandes du pool des labs interrompus (sinon VM réservées bloquées indéfiniment).
- **Page « Windows pool »** (admin) : réglages, tableau des templates avec actions selon l’état (configurer, marquer qualifié, activer/désactiver), labs en attente avec annulation, mesures, limites modifiables, quarantaines (chronologie, destruction) ; rafraîchissement toutes les 10 s uniquement quand la page est affichée.
- Validation : admin 6/6 et UI 3/3 ; chaîne de migrations 001→033 OK ; suite complète avec base **255 réussis / 0 échec**. Non déployé en dev.

## Tests d’acceptation transversaux

- [ ] Aucun clonage Windows direct pour deploy ou redeploy, même pool vide ou suspendu.
- [ ] Aucun accès réseau d’une VM du pool avant validation de sa configuration de lab.
- [ ] QGA disponible avant fin de préparation : la VM reste non prête.
- [ ] Marqueur hérité ou erroné : VM non prête ; redémarrage d’une VM préparée : contrôle correct.
- [ ] Cloudbase-Init ne réécrit ni IP ni mot de passe après affectation/redémarrage.
- [ ] Deux workers concurrents ne réservent jamais la même VM.
- [ ] Pénurie, demande supérieure à la réserve, plafond atteint et annulation ont des comportements vérifiés.
- [ ] Crash/timeout à chaque étape : reprise sans double clone, double affectation ou suppression étrangère.
- [ ] VMID occupé mais absent de l’inventaire visible : création bloquée ou nouvel ID choisi.
- [ ] Lab Windows seul sans création Terraform parasite ; lab mixte fonctionnel.
- [ ] Destruction partielle, redéploiement de poste et labs historiques correctement gérés.
- [ ] Avec un plafond supérieur à un, prouver par synchronisation contrôlée dans les tests que plusieurs opérations indépendantes sont actives en même temps ; une boucle séquentielle doit faire échouer ces tests.
- [ ] Avec plusieurs workers/réplicas, vérifier que les plafonds partagés ne sont jamais dépassés, y compris après crash, timeout ou annulation.
- [ ] Une VM lente, un redémarrage ou un backoff ne retarde pas les autres VM indépendantes ; les dépendances réseau/AD et barrières métier restent respectées.
- [ ] Vérifier le chevauchement Linux/Windows, de plusieurs labs et du réapprovisionnement, sans double mutation d’une VM ni double affectation.
- [ ] Mesurer sur infrastructure un lot représentatif en mode séquentiel puis parallèle avec conditions comparables, relever le délai total et les erreurs, et justifier les plafonds retenus avant activation.

## Repères dans le dépôt

| Zone | Fichiers à examiner |
|---|---|
| Création actuelle et repli liste vide | `terraform/main.tf` |
| Readiness WinRM/Cloudbase et déploiement | `workers/terraformWorker.js` |
| VMID calculés, templates, QGA et endpoints | `dashboard/server.js` |
| Verrous et récupération des jobs | `lib/jobConcurrency.js` |
| Limites de sondage et concurrence des customizations | `lib/readinessConcurrency.js`, `lib/customizationRecovery.js`, `lib/runCustomization.js` |
| Contrôle VMID | `lib/vmidAvailability.js` |
| Customizations et reprises | `lib/runCustomization.js`, `lib/customizationRecovery.js` |
| Destruction et durées | `lib/deploymentCleanup.js`, `lib/deploymentDurations.js` |
| Préparation des images Windows | `FilesForTemplates/` |
| Trace du retrait historique | `db/migrations/029-remove-vm-pools.sql` |

Pièges déjà identifiés : reset IP sélectionnant une NIC `Up`, DNS codés en dur dans ce chemin, readiness exigeant un marqueur plus récent que le boot, VMID reconstruits depuis le déploiement, suppression du déploiement après seul succès Terraform.

## Journal et passation

| Date | Agent | Lot | Résultat / preuves | Prochaine action |
|---|---|---|---|---|
| 2026-11-19 | Codex | Plan | Analyse du dépôt et plan établis ; aucune qualification Proxmox ni implémentation réalisée | Prendre P0 et qualifier un template représentatif |
| 2026-11-19 | Codex | Exigence transversale | Parallélisme ajouté au contrat, aux lots et aux critères d’acceptation ; documentation uniquement | Qualifier une VM, puis un petit lot concurrent et mesurer les limites de l’infrastructure |
| 2026-11-20 | Codex | P0 | Pilote 151 : préparation hors réseau, affectation QGA, WinRM et persistance réseau après reboot validés ; anomalie Cloudbase-Init réseau. Requalification lancée (`tmp/p0-complete.mjs`) | Terminer la requalification |
| 2026-11-20 | Claude | P0 | Reprise : requalification interrompue à 08:18 CET, VM 151/152 détruites manuellement (`root@pam`), aucune VM P0 restante ; versions consignées. Lecture API seule, aucune VM modifiée | Relancer `tmp/p0-complete.mjs` après accord, puis analyser le rapport |
| 2026-11-20 | Claude | P0 | Passage en linked clones ; correctifs Cloudbase-Init (configdrive2) et DHCP (registre `EnableDHCP=0`) qualifiés ; série 2 séquentielles + 2 parallèles réussie. Harnais : `tmp/p0-complete.mjs` | P0 validé par l’utilisateur ; VM 151–156 détruites. Prochaine action : P1 (intégrer linked clone, contrat de readiness QGA, contrat d’affectation réseau, reprise après rollout) |
| 2026-11-20 | Claude | P1 | Fichiers : `db/migrations/032-windows-pool.sql`, `lib/windowsPool/*.js`, `tests/windowsPool.test.js`, `tests/windowsPool.db.test.js`. Validation : `node --test tests/windowsPool.test.js` (16/16) ; `WINDOWS_POOL_TEST_DATABASE_URL=… node --test tests/windowsPool.db.test.js` (11/11, base dev, schéma isolé) ; chaîne de migrations 001→032 + rejeu OK ; tests existants concurrence/readiness/reprise 30/30. Limites : modules non branchés (aucun worker) ; plafonds initiaux non mesurés ; reprise après rollout du worker à concevoir en P2/P4 | Relecture P1 par l’utilisateur, puis P2 (worker d’alimentation) |
| 2026-11-20 | Claude | P1 | Relecture utilisateur : plage 70000–79999 et reste validés, exigence de VMID libres et exclusifs. Plage vérifiée libre (inventaire, volumes, 10 000 `nextid`). Ajouts : `createProxmoxVmidCheck` (3 sources), garde Terraform hors plage du pool (`lib/vmidAvailability.js`, `workers/terraformWorker.js`), stub de test dans `tests/jobConcurrency.test.js`. Validation : 81/81 sur `windowsPool`, `jobConcurrency` et suites worker liées | Commit P1 puis P2 ; P2 doit rappeler `createProxmoxVmidCheck` juste avant chaque clone |
| 2026-11-20 | Claude | P2 | Fichiers : `lib/windowsPool/{proxmox,manager}.js`, `workers/startWindowsPoolWorkerService.js`, `package.json`, `tests/windowsPool.manager.test.js`, `vmidAllocator.js` (volumes ciblés), migration 032 (`proxmox_pool`). Validation : unitaires 20/20, PostgreSQL 11/11, manager simulé 9/9 (×3), qualification réelle 2 VM réussie puis nettoyée. Limites : worker non déployé ; réserve et plafonds non calibrés ; VM prêtes laissées allumées (budget RAM à valider) | Relecture P2 ; manifeste Kubernetes (dépôt gitops) ; puis P3 (réservation et attente) |
| 2026-11-20 | Claude | P3 | Fichiers : `lib/windowsPool/{coordinator,waiting,cancellation}.js`, `reservation.js`, `workers/startWindowsPoolWorkerService.js`, `tests/helpers/windowsPoolFakeProxmox.js`, `tests/windowsPool.reservation.test.js`, `tests/windowsPool.manager.test.js` (helper extrait). Validation : 60/60 ×2 (unitaires, PostgreSQL, manager, réservation, jobConcurrency) sur base dev en schémas isolés, supprimés. Limites : non branché dans deploy/redeploy ; worker complet non démarré localement | Relecture P3 ; P4 (affectation, branchement deploy/redeploy, customizations) |
| 2026-11-20 | Claude | Mise en dev | Sur demande de l’utilisateur : `feature/windows-pool-p1` fusionnée sur `main` (`4e7e0b7`) et poussée ; CI « Build & Deploy Dev » réussie (tests, images `dashboard/worker/custom-tasks-4e7e0b7`, mise à jour GitOps dev) ; ArgoCD : dashboard et workers dev en `4e7e0b7`, pods `Running` sans redémarrage ; migration 032 appliquée en base dev (pool `paused`, plage 70000–79999, DNS 195.186.4.162/163, aucun template configuré, limites par défaut). Effectif pour tous les labs dev : P4c, P4d, mots de passe par VM. Prod non touchée | Avec accord : pousser la branche GitOps du worker du pool (dev), configurer et activer le template 147 en dev, essai réel deploy/redeploy/destroy |
| 2026-11-20 | Claude + utilisateur | Essai de bout en bout en dev | **Réussi.** Template 147 activé en dev (réserve 2, plafond 4, `peda-pve2`/`ceph-pool`, pool `labs-dev`, pause levée) : 2 VM prêtes en ~6 min 30 s. Lab « Windows server » (1 VM, mode test, salle A43, mots de passe par poste) déployé par l’utilisateur depuis le dashboard : réservation immédiate, affectation 49 s (VM 70000 : nom `1-bhu-windows-server-01-hh`, tags `185;bhu;labfactory-pool`, VLAN 72 connecté, `10.10.72.78/25 Preferred` seule IPv4, DHCP désactivé, passerelle `.1`, DNS 195.186.4.162/163, hostname `HH`, Cloudbase-Init désactivé), customization Ansible avec reboot ; lab `deployed` ~2 min 30 s après le clic. **Redeploy du poste 01** : 70001 réservée 12:09:22 UTC, 70000 coupée et arrêtée (`qmstop` 12:09:22, retrait 12:09:25) **avant** la configuration de 70001, 70001 `assigned` 12:10:14 avec ancienne affectation `replaced` et 70000 `deleting` dans la même transaction, 70000 détruite 12:10:18 ; nouvelle VM : même nom, VLAN 72, `10.10.72.78/25 Preferred` sans conflit ; lab `deployed` ~2 min 20 s. **Stop** du lab réussi sur la VM du pool. **Destroy** : Terraform « 0 destroyed » (aucune VM Terraform), pool : 70001 `deleting (LAB_DESTROYED)` puis `deleted` en 15 s, demandes/affectations purgées, ligne du lab supprimée ; ~5 s. Réserve regarnie automatiquement en parallèle (70002 prête, 70003 en préparation). Aucune quarantaine, aucune demande orpheline. Observation : un essai `win_ping` a dépassé son délai avant de réussir (WinRM juste après la connexion réseau) — sans effet, mais à surveiller | Laisser ou remettre le pool dev en pause (2 VM allumées en permanence) ; P6 (interface, supervision, mesures) ; décision sur la prod |
| 2026-11-20 | Claude | Démantèlement du pool dev | Sur demande de l’utilisateur (« supprimer le pool dev ») : template 147 désactivé (`enabled=false`, réserve 0), pool remis en pause, VM restantes 70002/70003 passées en `deleting` (code `POOL_DECOMMISSIONED`) et détruites par le gestionnaire après contrôle du marqueur (~1 min 30 s). Vérifié : aucun guest dans 70000–79999 sur Proxmox, aucun bail, aucune demande ouverte. Conservés : tables du pool (migration 032), configuration du template (désactivée), worker `labfactory-windows-pool-worker` (au repos, `Running`). Réactivation : `enabled=true` + réserve + `paused=false` | Retirer aussi le worker de GitOps dev si souhaité ; P6 ; prod |

Pour chaque passation, ajouter les fichiers touchés, commandes de validation, résultats, limites connues et décisions à confirmer. Les paramètres dépendant de l’infrastructure (template pilote, capacité, placement, permissions QGA et politique de révision) restent à préciser pendant P0/P1.
