
/* ===== VORTEX LEGENDS UPDATE SYSTEM ===== */

let publishedUpdate = {
  version: process.env.LATEST_VERSION || "1.0.0",
  minVersion: process.env.MIN_VERSION || "1.0.0",
  apkUrl: process.env.APK_URL || "",
  changelog: process.env.CHANGELOG || "Versão inicial",
  publishedAt: null,
  mandatory: true
};

function versionParts(v) {
  return String(v || "")
    .replace(/^v/i, "")
    .split(".")
    .map(x => parseInt(x, 10) || 0);
}

function compareVersions(a, b) {
  const A = versionParts(a);
  const B = versionParts(b);

  for (let i = 0; i < 3; i++) {
    const av = A[i] || 0;
    const bv = B[i] || 0;

    if (av !== bv) return av > bv ? 1 : -1;
  }

  return 0;
}

// Informações da última atualização
app.get("/api/update/latest", (req, res) => {
  res.json({
    ok: true,
    update: publishedUpdate
  });
});

// Verifica a versão instalada no jogador
app.get("/api/update/check", (req, res) => {
  const installed = String(req.query.version || "0.0.0");
  const update = publishedUpdate;

  const required =
    update.mandatory &&
    compareVersions(installed, update.minVersion) < 0;

  const available =
    compareVersions(installed, update.version) < 0;

  res.json({
    ok: true,
    installedVersion: installed,
    latestVersion: update.version,
    minVersion: update.minVersion,
    updateAvailable: available,
    required,
    mandatory: update.mandatory,
    apkUrl: available ? update.apkUrl : null,
    changelog: available ? update.changelog : null,
    publishedAt: update.publishedAt
  });
});

// Publica uma atualização pelo painel do proprietário
app.post("/api/admin/update/publish", (req, res) => {
  const key = process.env.OWNER_UPDATE_KEY;

  if (!key) {
    return res.status(503).json({
      ok: false,
      error: "Configure OWNER_UPDATE_KEY no Render."
    });
  }

  if (req.headers["x-admin-key"] !== key) {
    return res.status(403).json({
      ok: false,
      error: "Acesso de administrador negado."
    });
  }

  const { version, apkUrl, changelog } = req.body || {};

  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(version)
  ) {
    return res.status(400).json({
      ok: false,
      error: "Versão inválida. Exemplo: 22.0.1"
    });
  }

  if (typeof apkUrl !== "string" || !apkUrl.trim()) {
    return res.status(400).json({
      ok: false,
      error: "Link do APK obrigatório."
    });
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(apkUrl.trim());
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: "Link do APK inválido."
    });
  }

  if (parsedUrl.protocol !== "https:") {
    return res.status(400).json({
      ok: false,
      error: "O link do APK precisa usar HTTPS."
    });
  }

  if (compareVersions(version, publishedUpdate.version) <= 0) {
    return res.status(400).json({
      ok: false,
      error: "A nova versão precisa ser maior que a publicada."
    });
  }

  publishedUpdate = {
    version: version,
    minVersion: version,
    apkUrl: parsedUrl.href,
    changelog: String(changelog || "Nova atualização").slice(0, 2000),
    publishedAt: new Date().toISOString(),
    mandatory: true
  };

  io.emit("game:update:published", {
    version: version,
    mandatory: true
  });

  return res.json({
    ok: true,
    message: "Atualização publicada!",
    update: publishedUpdate
  });
});

/* ===== END VORTEX LEGENDS UPDATE SYSTEM ===== */
