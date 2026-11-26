const styles = `
  :host { display:block; color:#152033; font:14px/1.5 system-ui,sans-serif; }
  * { box-sizing:border-box; }
  .panel { border:1px solid #d8dee9; border-radius:12px; background:#fff; padding:clamp(16px,3vw,28px); }
  h2,h3,p { margin-top:0; }
  h2 { margin-bottom:6px; font-size:1.35rem; }
  h3 { margin-bottom:4px; font-size:1rem; }
  .muted { color:#586579; }
  .status { margin:16px 0; border-radius:8px; padding:12px 14px; font-weight:600; }
  .ready { background:#eaf7ef; color:#17633b; }
  .blocked { background:#fff3e8; color:#8a3b0b; }
  .result { display:flex; flex-wrap:wrap; gap:8px 24px; margin:18px 0; }
  .entry { margin-top:20px; border:1px solid #e0e5ed; border-radius:9px; overflow:hidden; }
  .entry-head { padding:14px 16px 8px; background:#f7f9fc; }
  .entry-meta { margin:0; color:#586579; font-size:.9rem; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; min-width:700px; }
  th,td { padding:9px 12px; border-top:1px solid #e7ebf1; text-align:left; vertical-align:top; }
  th { color:#465267; background:#fbfcfe; font-size:.8rem; text-transform:uppercase; letter-spacing:.03em; }
  .amount { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  tfoot td { font-weight:700; background:#fbfcfe; }
  .messages { margin:14px 0; padding-left:22px; }
  .errors { color:#9b2525; }
  .warnings { color:#815300; }
  .actions { display:flex; justify-content:flex-end; margin-top:22px; }
  button { border:0; border-radius:8px; padding:11px 18px; background:#155eef; color:white; font:inherit; font-weight:650; cursor:pointer; }
  button:disabled { background:#aab4c3; cursor:not-allowed; }
  button:focus-visible { outline:3px solid #9dbaff; outline-offset:2px; }
`;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function formatMoney(value) {
  const raw = String(value ?? "0.00");
  const negative = raw.startsWith("-");
  const [integer = "0", decimals = "00"] = raw.replace(/^-/, "").split(".");
  let grouped;
  try {
    grouped = new Intl.NumberFormat("es-PE").format(BigInt(integer || "0"));
  } catch {
    grouped = integer;
  }
  return `S/ ${negative ? "-" : ""}${grouped}.${decimals.padEnd(2, "0").slice(0, 2)}`;
}

class AnnualClosePreviewElement extends HTMLElement {
  constructor() {
    super();
    this._preview = undefined;
    this.attachShadow({ mode: "open" });
    const style = element("style");
    style.textContent = styles;
    this.shadowRoot.append(style);
    this.container = element("div", "panel");
    this.shadowRoot.append(this.container);
    this.render();
  }

  set preview(value) {
    this._preview = value;
    this.render();
  }

  get preview() {
    return this._preview;
  }

  render() {
    if (!this.container) return;
    this.container.replaceChildren();
    const preview = this._preview;
    if (!preview) {
      this.container.append(element("p", "muted", "Carga una vista previa para revisar los asientos del cierre anual."));
      return;
    }

    this.container.append(element("h2", "", `Vista previa del cierre anual ${preview.fiscalYear}`));
    this.container.append(element("p", "muted", `Empresa: ${preview.companyId} · Fecha: ${preview.closingDate} · Período: ${preview.closingPeriod}`));

    const status = element("div", `status ${preview.canClose ? "ready" : "blocked"}`,
      preview.canClose ? "Validación aprobada. Puedes confirmar el cierre." : "Cierre bloqueado. Revisa los impedimentos antes de continuar.");
    status.setAttribute("role", preview.canClose ? "status" : "alert");
    this.container.append(status);

    const result = element("div", "result");
    result.append(element("span", "", `Ingresos: ${formatMoney(preview.netIncome)}`));
    result.append(element("span", "", `Gastos: ${formatMoney(preview.netExpense)}`));
    result.append(element("strong", "", `Resultado: ${formatMoney(preview.accountingResult)} (${preview.resultType})`));
    this.container.append(result);

    if (preview.validation?.errors?.length) {
      const errors = element("ul", "messages errors");
      preview.validation.errors.forEach((message) => errors.append(element("li", "", message)));
      this.container.append(errors);
    }
    if (preview.validation?.warnings?.length) {
      const warnings = element("ul", "messages warnings");
      preview.validation.warnings.forEach((message) => warnings.append(element("li", "", message)));
      this.container.append(warnings);
    }

    for (const [index, entry] of (preview.entries ?? []).entries()) {
      const card = element("section", "entry");
      const head = element("div", "entry-head");
      head.append(element("h3", "", `${index + 1}. ${entry.title}`));
      head.append(element("p", "entry-meta", `${entry.glosa} · ${entry.entryDate} · ${entry.accountingPeriod} · ${entry.currency}`));
      card.append(head);

      const tableWrap = element("div", "table-wrap");
      const table = element("table");
      const thead = element("thead");
      const headerRow = element("tr");
      ["Cuenta", "Glosa", "Debe", "Haber"].forEach((label, i) => headerRow.append(element("th", i > 1 ? "amount" : "", label)));
      thead.append(headerRow);
      table.append(thead);

      const tbody = element("tbody");
      for (const line of entry.lines ?? []) {
        const row = element("tr");
        row.append(element("td", "", `${line.accountCode} · ${line.accountName}`));
        row.append(element("td", "", line.glosa));
        row.append(element("td", "amount", formatMoney(line.debit)));
        row.append(element("td", "amount", formatMoney(line.credit)));
        tbody.append(row);
      }
      table.append(tbody);

      const foot = element("tfoot");
      const totalRow = element("tr");
      totalRow.append(element("td", "", `${entry.accountsCount} líneas`));
      totalRow.append(element("td", "", entry.isBalanced ? "Asiento balanceado" : `Diferencia: ${formatMoney(entry.difference)}`));
      totalRow.append(element("td", "amount", formatMoney(entry.totalDebit)));
      totalRow.append(element("td", "amount", formatMoney(entry.totalCredit)));
      foot.append(totalRow);
      table.append(foot);
      tableWrap.append(table);
      card.append(tableWrap);
      this.container.append(card);
    }

    const actions = element("div", "actions");
    const confirm = element("button", "", "Confirmar cierre anual");
    confirm.type = "button";
    confirm.disabled = !preview.canClose;
    confirm.addEventListener("click", () => {
      if (!this._preview?.canClose) return;
      this.dispatchEvent(new CustomEvent("annual-close-confirm", {
        bubbles: true,
        composed: true,
        detail: {
          companyId: this._preview.companyId,
          fiscalYear: this._preview.fiscalYear,
          closingDate: this._preview.closingDate,
          closingPeriod: this._preview.closingPeriod,
          expectedRevision: this._preview.revision,
          generateNextYearOpening: this._preview.summary?.entriesByType?.hasNextYearOpening === true,
          previewGeneratedAt: this._preview.generatedAt,
        },
      }));
    });
    actions.append(confirm);
    this.container.append(actions);
  }
}

if (!customElements.get("annual-close-preview")) {
  customElements.define("annual-close-preview", AnnualClosePreviewElement);
}
