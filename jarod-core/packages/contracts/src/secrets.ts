/**
 * Noms des secrets partagés entre frontends (desktop, CLI, relay) : la table `secrets` du profil.
 * Extraits à l'identique de leurs fichiers source (rév. 2e180305) ; les valeurs ne vivent jamais ici.
 */
// core.ts:124-124
export const TELEGRAM_TOKEN_KEY = "gateway:telegram:token";
// core.ts:125-125
export const DISCORD_TOKEN_KEY = "gateway:discord:token";
// core.ts:126-126
export const SLACK_BOT_TOKEN_KEY = "gateway:slack:bot-token";
// core.ts:127-127
export const SLACK_APP_TOKEN_KEY = "gateway:slack:app-token";
// remote/host.ts:20-20
export const RELAY_TOKEN_KEY = "remote:relay-token";
// services/email.ts:36-36
export const EMAIL_PASSWORD_KEY = "gateway:email:password";
// services/whatsapp.ts:32-32
export const WHATSAPP_TOKEN_KEY = "gateway:whatsapp:token";
// services/whatsapp.ts:33-33
export const WHATSAPP_APP_SECRET_KEY = "gateway:whatsapp:app-secret";
