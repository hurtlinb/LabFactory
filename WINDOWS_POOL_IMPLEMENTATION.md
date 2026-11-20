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
| P2 — Préparation et alimentation | P1 | Non attribué | à faire | — |
| P3 — Réservation et attente | P1, P2 | Non attribué | à faire | — |
| P4 — Affectation et customizations | P2, P3 | Non attribué | à faire | — |
| P5 — Cycle de vie et compatibilité | P4 | Non attribué | à faire | — |
| P6 — Interface, supervision et activation | P5 | Non attribué | à faire | — |

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

- [ ] Créer un worker dédié indépendant du verrou global Terraform.
- [ ] Centraliser l’allocation des VMID (`allocatePoolVm`) ; rappeler `createProxmoxVmidCheck` (registre + inventaire + volumes) **juste avant chaque clone**, et traiter les collisions sans adopter ni détruire de VM étrangère.
- [ ] Journaliser les tâches Proxmox et réconcilier les résultats incertains avant répétition.
- [ ] Garantir la déconnexion persistante des NIC avant tout démarrage.
- [ ] Créer un marqueur de préparation lié à la VM et à la révision, distinct de la disponibilité du boot courant.
- [ ] Empêcher Cloudbase-Init de réappliquer les paramètres provisoires après affectation.
- [ ] Limiter les préparations simultanées et renouveler le stock selon réserve et demandes en attente.
- [ ] Exécuter clones et préparations en parallèle entre VM/templates ; appliquer des budgets partagés entre réplicas et réconcilier les opérations toujours actives après crash.
- [ ] Limiter les sondages individuellement, sans garder leur créneau pendant les backoffs ou l’attente de fin de préparation.
- [ ] Gérer les nouvelles révisions, la quarantaine et les reprises après arrêt du worker.

## P3 — Réservation et attente

- [ ] Calculer les besoins par template/révision et réserver toutes les Windows d’un lab dans une transaction courte.
- [ ] En pénurie : ne réserver aucun lot partiel, enregistrer `waiting_for_pool`, différer sans consommer une tentative ou conserver un worker/verrou.
- [ ] Réveiller les demandes lors de l’arrivée de stock, avec réconciliation périodique de secours.
- [ ] Prévenir la famine des gros labs et les doubles affectations entre workers.
- [ ] Vérifier qu’un lab en attente n’empêche ni d’autres labs indépendants de progresser, ni le pool de se remplir.
- [ ] Distinguer réserve et plafond : une demande supérieure à la réserve doit pouvoir déclencher une préparation suffisante.
- [ ] Afficher un blocage explicite si le plafond ou la suspension du pool empêche la satisfaction de la demande ; aucun clonage direct.
- [ ] Permettre l’annulation et libérer uniquement les réservations intactes et revérifiées.

## P4 — Affectation et customizations

- [ ] Persister les VMID attribués et utiliser ces identités dans tous les payloads.
- [ ] Appliquer nom, tags, ressources et disques ; gérer les éventuels redémarrages avant connexion réseau.
- [ ] Configurer bridge/VLAN, puis IP/DNS et identifiants via QGA en conservant NIC et MAC.
- [ ] Vérifier par QGA avant de reconnecter, puis vérifier WinRM depuis le worker.
- [ ] Réutiliser les customizations existantes et leurs dépendances, notamment contrôleurs de domaine avant membres.
- [ ] Exécuter en parallèle les chaînes d’affectation des VM et les branches Linux/Windows d’un lab mixte après réservation ; ne pas attendre toutes les VM avant une étape indépendante.
- [ ] Revoir les barrières globales et le traitement Linux puis Windows dans les customizations ; conserver les barrières métier justifiées et ordonner les dépendances AD par poste/réseau/domaine.
- [ ] Paralléliser les validations indépendantes des blocs Ansible tout en conservant la barrière « toutes les validations réussies avant mutation » ; remplacer les limites locales codées en dur par les budgets configurables définis en P1.
- [ ] Exclure toute création Windows des plans Terraform ; ne pas lancer le repli Terraform avec une liste vide pour un lab 100 % Windows.

## P5 — Cycle de vie et compatibilité

- [ ] Utiliser les affectations réelles pour affichage, statut, start/stop, snapshots, reset IP/mot de passe, propriétaire, exports et customizations.
- [ ] Réserver les remplaçantes avant suppression des anciennes Windows lors d’un redéploiement de poste.
- [ ] Terminer la destruction d’un lab seulement après succès de tous ses gestionnaires ; conserver les informations nécessaires en cas d’échec partiel.
- [ ] Reprendre chaque opération sur la même affectation après crash ; ne pas libérer aveuglément une réservation expirée.
- [ ] Vérifier l’identité de propriété avant toute opération sensible.
- [ ] Paralléliser les opérations de cycle de vie sur VM indépendantes, agréger tous les résultats et reprendre uniquement les opérations incomplètes après échec partiel.
- [ ] Conserver la gestion historique des VM existantes sans retrait implicite de leur état Terraform.
- [ ] Adapter les remplacements historiques pour que toute nouvelle Windows passe par le pool.
- [ ] Auditer les éventuelles VM laissées par l’ancien pool, sans adoption ou suppression automatique.

## P6 — Interface, supervision et activation

- [ ] Ajouter configuration et compteurs par template : prêtes, en préparation, réservées, en erreur.
- [ ] Afficher les besoins manquants et permettre l’annulation des labs en attente.
- [ ] Adapter états occupés, récupération des jobs et reconstruction des statuts pour ne pas déclarer détruit un lab en attente.
- [ ] Mesurer attente du pool, intégration réseau, customization et délai total utilisateur séparément.
- [ ] Exposer opérations actives/en attente par catégorie, temps d’attente des limites/verrous et chronologie par VM ; comparer les durées avec pool prêt et pool vide sans confondre les deux scénarios.
- [ ] Qualifier chaque template avant activation et documenter le dimensionnement.
- [ ] Prévoir une suspension contrôlée : arrêter les nouvelles affectations sans repli direct ni impact sur les labs existants.

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

Pour chaque passation, ajouter les fichiers touchés, commandes de validation, résultats, limites connues et décisions à confirmer. Les paramètres dépendant de l’infrastructure (template pilote, capacité, placement, permissions QGA et politique de révision) restent à préciser pendant P0/P1.
