# Suivi d’implémentation — Pool de VM Windows

Créé le 2026-11-19. Statut : plan établi, qualification technique à réaliser.

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
| P0 — Qualification sur une VM | Aucune | Non attribué | à faire | — |
| P1 — Contrats et données | P0 | Non attribué | à faire | — |
| P2 — Préparation et alimentation | P1 | Non attribué | à faire | — |
| P3 — Réservation et attente | P1, P2 | Non attribué | à faire | — |
| P4 — Affectation et customizations | P2, P3 | Non attribué | à faire | — |
| P5 — Cycle de vie et compatibilité | P4 | Non attribué | à faire | — |
| P6 — Interface, supervision et activation | P5 | Non attribué | à faire | — |

## P0 — Première action : qualifier une VM Windows

Objectif : prouver le parcours complet avant de développer le gestionnaire du pool.

- [ ] Identifier un template représentatif, un réseau de test et le périmètre Proxmox autorisé.
- [ ] Consigner les versions Windows, Proxmox, QGA et Cloudbase-Init utilisées.
- [ ] Vérifier un VMID libre, cloner sans démarrer, imposer et relire la déconnexion de toutes les NIC avant le premier démarrage.
- [ ] Laisser terminer les étapes post-Sysprep et Cloudbase-Init sans réseau.
- [ ] Vérifier via QGA la fin effective de la préparation ; un simple ping agent ou `done.flag` ne suffit pas.
- [ ] Identifier la NIC Windows par sa MAC, même si elle est déconnectée.
- [ ] Configurer bridge/VLAN puis IP, préfixe, passerelle, DNS et mot de passe via QGA, lien toujours coupé.
- [ ] Relire la configuration, connecter la NIC et tester WinRM depuis le worker.
- [ ] Exécuter une customization simple, redémarrer et vérifier la persistance réseau/mot de passe.
- [ ] Mesurer séparément préparation, affectation et customization.
- [ ] Après réussite sur une VM, qualifier un petit lot de VM simultanées dans le périmètre autorisé : vérifier le chevauchement de préparation/affectation et comparer à une exécution séquentielle équivalente.
- [ ] Documenter le résultat et le devenir de la VM de test.

Critère de passage : VM utilisable sans nouveau Sysprep, préparation vérifiable hors réseau, configuration conservée après redémarrage. Tout blocage doit être résolu avant P1/P2.

## P1 — Contrats et données

- [ ] Définir la configuration par template : activation, réserve prête cible, capacité maximale, parallélisme, placement, révision et timeout.
- [ ] Définir inventaire et affectations : cluster, VMID, nœud, template/révision, identité de propriété, emplacement logique, gestionnaire, état, checkpoints, erreurs et dates.
- [ ] Prévoir l’historique des remplacements et une seule affectation active par emplacement logique.
- [ ] Ajouter contraintes d’unicité, transactions de réservation et contrôle de version des opérations.
- [ ] Définir le contrat QGA : commandes, délais, résultats structurés, erreurs, annulation et protection des secrets.
- [ ] Définir le graphe de dépendances, les plafonds distribués par catégorie d’opération, les règles d’équité et les verrous par lab/workspace/VM.
- [ ] Créer une nouvelle migration après la dernière existante ; ne pas réutiliser les migrations historiques du pool.

## P2 — Préparation et alimentation

- [ ] Créer un worker dédié indépendant du verrou global Terraform.
- [ ] Centraliser l’allocation des VMID ; contrôler `cluster/nextid?vmid=…` avant création et traiter les collisions sans adopter de VM étrangère.
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

Pour chaque passation, ajouter les fichiers touchés, commandes de validation, résultats, limites connues et décisions à confirmer. Les paramètres dépendant de l’infrastructure (template pilote, capacité, placement, permissions QGA et politique de révision) restent à préciser pendant P0/P1.
