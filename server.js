
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
    if ((A[i] || 0) !== (B[i] || 0))
      return (A[i] || 0) > (B[i] || 0) ? 1 : -1;
  }
  return 0;
}

app.get("/api/update/latest", (req, res) => {
  res.json({
    ok: true,
    update: publishedUpdate
  });
});

app.get("/api/update/check", (req, res) => {
  const installed = String(req.query.version || "0.0.0");
  const update = publishedUpdate;

  const required =
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
    apkUrl: available ? update.apkUrl : null,
    changelog: available ? update.changelog : null,
    publishedAt: update.publishedAt
  });
});

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

  if (!version || !/^\\d+\\.\\d+\\.\\d+$/.test(version)) {
    return res.status(400).json({
      ok: false,
      error: "Versão inválida. Exemplo: 2.0.1"
    });
  }

  if (!apkUrl) {
    return res.status(400).json({
      ok: false,
      error: "Link do APK obrigatório."
    });
  }

  let parsed;
  try {
    parsed = new URL(apkUrl);
  } catch {
    return res.status(400).json({
      ok: false,
      error: "Link do APK inválido."
    });
  }

  if (parsed.protocol !== "https:") {
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
    version,
    minVersion: version,
    apkUrl: parsed.href,
    changelog: String(changelog || "Nova atualização").slice(0, 2000),
    publishedAt: new Date().toISOString(),
    mandatory: true
  };

  io.emit("game:update:published", {
    version,
    mandatory: true
  });

  res.json({
    ok: true,
    message: "Atualização publicada!",
    update: publishedUpdate
  });
});
/* ===== END UPDATE SYSTEM ===== */
