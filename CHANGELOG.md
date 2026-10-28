# Changelog

Les nouvelles fonctionnalités de LabFactory, par version. Les releases contenant uniquement des correctifs ou des ajustements ne sont pas affichées.

## [2.0.3] — 2026-10-28

- Security fix

## [2.0.0] — 2026-10-10

- UI change

## [1.8.2] — 2026-10-09

- Démarrage et arrêt des labs directement depuis le dashboard.
- Consultation des identifiants des VM dans les détails du déploiement, avec affichage du mot de passe à la demande.
- Aperçu des VM de chaque blueprint dans la bibliothèque.

## [1.8.0] — 2026-09-30

- Tâches Ansible personnalisées par VM (bêta), avec validation et suivi des résultats.
- Modification des personnalisations existantes : nom de machine, fuseau horaire, second disque et configuration de domaine.

## [1.7.10] — 2026-09-29

- Suivi des personnalisations réussies, en attente ou en échec pour chaque VM.
- Reprise des personnalisations incomplètes sans recommencer les étapes réussies.

## [1.7.8] — 2026-09-17

- Génération de mots de passe alphanumériques par poste de travail.
- Export CSV avec les identifiants adaptés au système et à la langue de chaque VM.

## [1.7.7] — 2026-09-17

- Ajout de fichiers à copier sur les VM Windows et Linux lors du déploiement.
- Inventaire des fichiers et de l'espace de stockage pour les administrateurs.
- Choix entre un mot de passe partagé et un mot de passe par poste, avec export CSV des informations des VM.

## [1.7.6] — 2026-09-11

- Suspension des mises à jour Windows pendant 35 jours.
- Actions sur plusieurs VM à la fois : réinitialisation de l'IP, du mot de passe ou suspension des mises à jour, avec suivi par VM.

## [1.7.5] — 2026-07-21

- Filtre pour afficher tous les labs ou uniquement les siens.
- Gestion des droits sur les labs : déploiement et suppression réservés au propriétaire et aux administrateurs.
- Verrouillage des blueprints utilisés par un lab déployé.

## [1.7.3] — 2026-06-25

- Indicateur de disponibilité de Redis.
- Redéploiement d'un poste individuel après l'échec d'un lab.
- Suivi du redémarrage Windows pour chaque VM.

## [1.7.0] — 2026-06-22

- Ajout d'un second disque aux VM Windows et Linux, avec configuration automatique ou disque laissé brut.

## [1.6.0] — 2026-06-19

- Rôles enseignant et administrateur pour contrôler l'accès aux fonctionnalités.
- Affichage du rôle de chaque utilisateur dans la page Users.

## [1.5.0] — 2026-06-16

- Réinitialisation du mot de passe administrateur d'une VM.
- Consultation du changelog et de la version depuis le dashboard.

## [1.4.0] — 2026-06-12

- Publication des versions en développement et en production via CI/CD.

## [1.3.2] — 2026-06-12

- Réinitialisation de l'adresse IP d'une VM Windows ou Linux.

## [1.3.0] — 2026-06-12

- Avertissement lorsqu'une salle est déjà occupée par un lab actif.
- Affichage du propriétaire sur les cartes des labs et des salles.
