# Vente de tokens (module optionnel)

Copyright © 2026 Fido-labs —kcw—

Boutique intégrée : vous vendez des **tokens prépayés** (1 M = 3 USD par défaut) ; l'acheteur reçoit une **licence** `phx-…` qui est une clé API PhenixRouter, utilisable sur PC (Claude Code, Codex, Cursor, curl, SDK) comme sur mobile (toute application « OpenAI compatible »). Le même module suit le **solde et la consommation**.

> Désactivé par défaut. Pour tout retirer : décochez « Activé » (Ventes), ou supprimez `src/shop/`, `public/shop/` et les lignes `shop` des fichiers qui l'importent.

## Mise en route
1. `phenixrouter start`, puis vue **Fournisseurs** : ajoutez *vos* clés payantes et cochez **Revente** sur les connexions à vendre (les licences vendues n'utilisent que celles-ci).
2. Vue **Ventes** : activez, réglez prix/packs/multiplicateurs, mode de paiement, URL publique (tunnel ou domaine).
3. Partagez `https://votre-domaine/shop`.

## Paiements
- **Manuel** : instructions affichées avec une référence `PHX-XXXXXX` ; vous confirmez dans « Ventes » (ou remise hors ligne : Mobile Money, espèces, cadeau).
- **Binance Pay** (compte marchand requis) : création de commande signée (HMAC‑SHA512), statut **revérifié par appel signé** à chaque suivi ; le webhook ne sert qu'à déclencher cette vérification ; montant contrôlé. *Écrit d'après la documentation publique, non testé en réel : essayez avec une petite commande.*

## REA (Resource‑Event‑Agent)
| Resources | Events | Agents |
|---|---|---|
| Crédit de tokens, trésorerie (USDT / Mobile Money), licence (clé prépayée) | ORDER_COMMITTED, PAYMENT_RECEIVED, CREDIT_GRANTED, CREDIT_CONSUMED (échanges du grand livre) | Acheteur, boutique/vendeur, fournisseur amont, passerelle de paiement |

**Dualité** : PAYMENT_RECEIVED (trésorerie ↑) ↔ CREDIT_GRANTED (crédit ↓ côté vendeur / ↑ côté acheteur), exactement une fois par commande ; `ShopLedger.verifyDuality()` signale toute dérive. Le livre `sales.jsonl` est chaîné par hachage (altération détectée).

```
[Acheteur] --ORDER_COMMITTED--> [Boutique]
[Acheteur] --PAYMENT_RECEIVED--> (Cash USDT)        <- dualité ->
[Boutique] --CREDIT_GRANTED----> (Licence + crédit)
[Licence ] --CREDIT_CONSUMED---> [Fournisseur amont]  (par appel réussi, × multiplicateur du modèle)
```

## Consommation
Débit = tokens (entrée + sortie) × multiplicateur du modèle (`openai/gpt-4o=5`, `groq/*=1`), hors réponses en cache. À zéro : `402 insufficient_credits`. Recharge : commander avec la clé existante.

## Sécurité
Jeton secret par commande (haché) ; limites de débit par IP réelle ; administration refusée via tunnel tant que la boutique est active (`allowRemoteAdmin` pour lever) ; secrets Binance scellés ; clé en clair effacée après 24 h (le solde reste consultable avec la clé).

## Réserves à connaître
- **Conditions des fournisseurs** : revendre l'accès à des offres gratuites ou personnelles est généralement interdit ; ne vendez que ce que vous avez le droit de vendre.
- **Marge** : 1 M = 3 $ peut être déficitaire sur des modèles chers → multiplicateurs.
- **Fiscalité / réglementation** des ventes en cryptomonnaie : à vérifier localement.
