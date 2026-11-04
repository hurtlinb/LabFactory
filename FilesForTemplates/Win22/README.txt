Windows Server 2022 x64 - configuration corrigee pour le clonage

Evaluation Standard pour le lab :
- Installer depuis le media Windows Server 2022 Evaluation, edition Standard.
- Verifier dans la VM : DISM /Online /Get-CurrentEdition
  Le resultat attendu est ServerStandardEval. ServerStandard sans Eval
  n'est pas une edition d'evaluation ; ce fichier ne la convertit pas.
- Aucune cle produit n'est injectee. La duree d'evaluation reste applicable.
- SkipMachineOOBE=true est retabli uniquement pour ce template de lab afin
  de passer l'OOBE machine et sa demande de cle. Ce parametre est deconseille
  par Microsoft pour l'automatisation moderne ; tester sur un nouveau clone.
  Il ne remplace pas une licence et ne prolonge pas l'evaluation.
- Sur une VM deja bloquee sur cet ecran, choisir "Do this later".
  Le fichier du depot ne modifie pas l'OOBE deja en cours dans cette VM.

Reference : https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/automate-oobe

Langues et region :
- Interface et installation : en-US (utiliser un media Windows anglais).
- Formats regionaux : fr-CH (francais, Suisse).
- Clavier : suisse francais, 100c:0000100c, conserve depuis Win22.
- Langue systeme des applications non Unicode : en-US, comme Win22.
- Fuseau horaire : W. Europe Standard Time (Suisse).
- Compte local integre : Administrator, non renomme.

Preparation dans la VM source, avant capture :
1. Installer Cloudbase-Init.
2. Copier cloudbase-init.conf dans :
   C:\Program Files\Cloudbase Solutions\Cloudbase-Init\conf\
3. Copier 99-finish.ps1 dans :
   C:\Program Files\Cloudbase Solutions\Cloudbase-Init\LocalScripts\
4. Copier unattend.xml dans C:\Windows\System32\Sysprep\unattend.xml.
5. Executer dans PowerShell administrateur :

   & "$env:WINDIR\System32\Sysprep\Sysprep.exe" /generalize /oobe /shutdown /mode:vm /unattend:C:\Windows\System32\Sysprep\unattend.xml

6. Convertir la VM arretee en template sans la redemarrer, puis cloner.

Au demarrage du clone, specialize active Administrator par son SID -500,
configure WinRM sequentiellement, supprime le done.flag herite et remet le
service Cloudbase-Init en demarrage automatique s'il est installe.
Le mot de passe initial et la connexion automatique unique sont conserves
depuis Win22. Cloudbase-Init peut remplacer le mot de passe via ConfigDrive.
Le nom du compte reste Administrator meme avec les formats fr-CH.

WinRM conserve Basic et AllowUnencrypted pour le fonctionnement existant.
Cloudbase-Init conserve les plugins reseau, mot de passe, WinRM et scripts
locaux de Win22. Le chemin LocalScripts est maintenant explicite.
Le script final ne desactive plus le service : stop_service_on_exit=true
arrete l'execution courante, sans empecher les demarrages suivants.
done.flag indique le passage du script final, pas la validation de tous les
plugins precedents. Verifier cloudbase-init.log sur le premier clone.

Validation a effectuer sur un clone Server 2022 : connexion Administrator,
formats fr-CH, clavier suisse francais, reseau et acces WinRM depuis le
runner, mot de passe injecte et presence du nouveau done.flag.
Les fichiers seuls ne constituent pas une image VM prete a demarrer.
