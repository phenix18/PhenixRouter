# Politique de sécurité

Copyright © 2026 Fido-labs —kcw—

## Signaler une vulnérabilité
Ne publiez pas de faille dans une issue publique. Écrivez au mainteneur via le profil GitHub **phenix18** (message privé / « Security advisories » du dépôt) avec : version, étapes de reproduction, impact. Réponse visée sous 7 jours.

## Garanties par défaut
- Écoute sur `127.0.0.1` uniquement ; mot de passe du tableau de bord aléatoire, affiché une fois (scrypt).
- Clés fournisseurs chiffrées au repos (AES‑256‑GCM) ; fichiers de données en `600`.
- Session HttpOnly + SameSite=Strict, contrôle d'Origin sur les écritures, CSP stricte, anti-force-brute sur la connexion.
- Garde SSRF sur la lecture web ; proxys : échec fermé ; identifiants de vidéo signés HMAC.
- Aucune télémétrie. Aucun code d'interception (MITM) ni réutilisation de jetons d'abonnement.

## À votre charge si vous l'exposez
Mettez un proxy HTTPS devant, un mot de passe fort, un pare-feu ; ne renseignez `corsOrigins` qu'avec des origines de confiance.
