Windows 11 x64 - interface fr-FR, region et clavier fr-CH

Preparation du template (PowerShell administrateur dans la VM) :

1. Copier unattend.xml dans C:\Windows\System32\Sysprep\unattend.xml.
2. Copier cloudbase-init.conf dans :
   C:\Program Files\Cloudbase Solutions\Cloudbase-Init\conf\
3. Copier 99-finish.ps1 dans :
   C:\Program Files\Cloudbase Solutions\Cloudbase-Init\LocalScripts\
4. Generaliser et arreter avec le fichier de reponses explicite :

   & "$env:WINDIR\System32\Sysprep\Sysprep.exe" /generalize /oobe /shutdown /mode:vm /unattend:C:\Windows\System32\Sysprep\unattend.xml

5. Convertir la VM arretee en template, sans la redemarrer, puis cloner.

Au prochain demarrage, specialize active le compte integre par son SID -500,
configure WinRM et supprime le done.flag herite. Le compte francais attendu
par AutoLogon et Cloudbase-Init est Administrateur (non renomme).
Le mot de passe initial reste celui de unattend.xml ; Cloudbase-Init peut
ensuite le remplacer avec le mot de passe fourni dans les metadonnees.

WinRM conserve Basic et AllowUnencrypted pour le fonctionnement existant.
Sur un reseau public, Enable-PSRemoting limite l'acces au sous-reseau local.
Le pack d'interface fr-FR doit etre present dans l'image Windows.

Ne pas utiliser unattend_old.xml : il est conserve comme archive uniquement.
Ne pas desactiver le service Cloudbase-Init avant la capture. Sa configuration
stop_service_on_exit arrete l'execution sans desactiver les demarrages suivants.
done.flag indique le passage du script final, pas une validation de tous les
plugins precedents. Verifier aussi cloudbase-init.log apres le premier clone.

Les fichiers modifies sur l'hote ne reparent pas une VM deja clonee :
repreparer le template avec ces fichiers puis creer un nouveau clone.
