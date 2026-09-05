"use strict";

const form = document.querySelector("#setup");
const previewFile = document.querySelector("#file");
const previewCode = document.querySelector("#code");
const errorBox = document.querySelector("#error");
const downloadButton = document.querySelector("#download");
const copyButton = document.querySelector("#copy");
const feedback = document.querySelector("#feedback");
let deployment = null;
let privateVisible = false;

function renderComponents() {
  const container = document.querySelector("#components");
  for (const component of CS2KZ.componentCatalog) {
    const row = document.createElement("div");
    row.className = "component";
    row.innerHTML = `
      <div class="component-heading">
        <div><h3 class="component-title">${component.name}${component.required ? '<span class="required-badge">REQUIRED</span>' : ""}</h3><p class="component-description">${component.description}</p></div>
        <select name="${component.id}_policy" aria-label="${component.name} installation policy">
          <option value="latest">Latest</option><option value="pin">Pin version</option>${component.required ? "" : '<option value="off">Disabled</option>'}
        </select>
      </div>
      <div class="fields" id="${component.id}-pin" hidden>
        <label>Release version<input name="${component.id}_version" spellcheck="false" placeholder="${component.id === "metamod" ? "2.0.0-git1411" : "Exact release tag"}" required /></label>
        <label>Archive SHA256 <span class="optional">optional</span><input name="${component.id}_sha256" spellcheck="false" pattern="[a-fA-F0-9]{64}" maxlength="64" /></label>
      </div>`;
    container.append(row);
  }
}

function syncControls() {
  const building = form.elements.source.value === "build";
  const sftp = form.elements.sftp.checked;
  document.querySelector("#image-field").hidden = building;
  form.elements.image.disabled = building;
  form.elements.image.required = !building;
  document.querySelector("#source-help").textContent = building
    ? "Extract your download into this repository’s deployments folder."
    : "Extract anywhere. Docker will pull the standalone image you supply.";
  document.querySelector("#sftp-fields").hidden = !sftp;
  for (const input of document.querySelectorAll("#sftp-fields input, #sftp-fields textarea")) {
    input.disabled = !sftp;
  }
  form.elements.keys.required = sftp;
  document.querySelector("#sftp-image-field").hidden = building;
  form.elements.sftp_image.disabled = building || !sftp;
  form.elements.sftp_image.required = !building && sftp;
  document.querySelector("#base-field").hidden = !building;
  form.elements.base_image.disabled = !building;
  form.elements.base_image.required = building;
  document.querySelector("#sftp-base-field").hidden = !building || !sftp;
  form.elements.sftp_base.disabled = !building || !sftp;
  form.elements.sftp_base.required = building && sftp;
  form.elements.expected_build.disabled = form.elements.update.checked;
  for (const component of CS2KZ.componentCatalog) {
    const pinned = form.elements[`${component.id}_policy`].value === "pin";
    const group = document.getElementById(`${component.id}-pin`);
    group.hidden = !pinned;
    for (const input of group.querySelectorAll("input")) {
      input.disabled = !pinned;
    }
  }
}

function readValues() {
  const invalid = form.querySelector(":invalid");
  if (invalid) {
    const label = invalid.labels?.[0]?.childNodes[0]?.textContent.trim() || "Configuration";
    throw new Error(`${label}: ${invalid.validationMessage}`);
  }
  const values = Object.fromEntries(new FormData(form));
  for (const field of ["update", "validate", "sftp"]) {
    values[field] = form.elements[field].checked;
  }
  for (const field of ["port", "maxplayers", "interval_hours", "warning_seconds", "sftp_port"]) {
    values[field] = Number(form.elements[field].value);
  }
  values.expected_build = values.update ? "" : form.elements.expected_build.value.trim();
  values.keys = form.elements.keys.value.trim();
  values.components = {};
  for (const component of CS2KZ.componentCatalog) {
    const policy = form.elements[`${component.id}_policy`].value;
    values.components[component.id] = {
      version: policy === "pin" ? form.elements[`${component.id}_version`].value.trim() : policy,
      sha256: policy === "pin" ? form.elements[`${component.id}_sha256`].value.trim() : "",
    };
    if (policy === "pin" && ["latest", "off"].includes(values.components[component.id].version)) {
      throw new Error(`Enter a fixed release version for ${component.name}.`);
    }
  }
  for (const key of [
    "name",
    "map",
    "branch",
    "workshop_map",
    "image",
    "sftp_image",
    "base_image",
    "sftp_base",
    "gslt",
  ]) {
    if (typeof values[key] === "string") {
      values[key] = values[key].trim();
    }
  }
  return values;
}

function showPreview() {
  const filename = previewFile.value;
  const sensitive = ["config/server-private.cfg", "config/cs2kz-server-config.txt"].includes(
    filename,
  );
  const masked = sensitive && !privateVisible;
  document.querySelector("#secret-notice").hidden = !sensitive || !deployment;
  document.querySelector("#reveal").textContent = privateVisible
    ? "Hide contents"
    : "Show contents";
  copyButton.disabled = !deployment || masked;
  if (!deployment) {
    previewCode.textContent = "Complete the configuration to preview your files.";
    return;
  }
  previewCode.textContent = masked
    ? "Contents hidden in the preview.\nYour ZIP will include the complete file."
    : deployment.files[filename];
}

function refresh() {
  syncControls();
  privateVisible = false;
  feedback.textContent = "";
  try {
    const values = readValues();
    deployment = CS2KZ.generate(values);
    deployment.name = values.name;
    const selected = previewFile.value;
    previewFile.replaceChildren();
    for (const filename of Object.keys(deployment.files)) {
      previewFile.add(new Option(filename, filename));
    }
    if (Object.hasOwn(deployment.files, selected)) {
      previewFile.value = selected;
    }
    const count = Object.values(deployment.settings.components).filter(
      (component) => component.version !== "off",
    ).length;
    document.querySelector("#summary").textContent =
      `${count} plugins · UDP ${values.port} · ${values.sftp ? "SFTP enabled" : "SFTP off"}`;
    const firstStep = document.querySelector("#instructions li");
    firstStep.textContent =
      values.source === "build"
        ? "Extract into this repository’s deployments folder."
        : "Extract the deployment anywhere on your Docker host.";
    document.querySelector("#instructions code").textContent =
      values.source === "build" ? "docker compose up -d --build" : "docker compose up -d";
    errorBox.hidden = true;
    downloadButton.disabled = false;
  } catch (error) {
    deployment = null;
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    downloadButton.disabled = true;
    document.querySelector("#summary").textContent = "A few details need your attention.";
  }
  showPreview();
}

function regeneratePassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  form.elements.rcon.value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

form.addEventListener("submit", (event) => event.preventDefault());
form.addEventListener("input", refresh);
form.addEventListener("change", refresh);
previewFile.addEventListener("change", () => {
  privateVisible = false;
  feedback.textContent = "";
  showPreview();
});
document.querySelector("#reveal").addEventListener("click", () => {
  privateVisible = !privateVisible;
  showPreview();
});
document.querySelector("#regenerate").addEventListener("click", () => {
  regeneratePassword();
  refresh();
});
copyButton.addEventListener("click", async () => {
  if (!deployment || copyButton.disabled) {
    return;
  }
  try {
    await navigator.clipboard.writeText(deployment.files[previewFile.value]);
    feedback.textContent = "Copied to clipboard.";
  } catch {
    feedback.textContent = "Clipboard unavailable. Select the preview text to copy it manually.";
  }
});
downloadButton.addEventListener("click", () => {
  refresh();
  if (!deployment) {
    return;
  }
  const blob = CS2KZ.createZip(deployment.files, deployment.name);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${deployment.name}-deployment.zip`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  feedback.textContent = "Download prepared. Follow the included START-HERE.md.";
});

renderComponents();
regeneratePassword();
refresh();
