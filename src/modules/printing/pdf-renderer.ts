import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type { PrintableCpe, PrintFormat, PrintOptions, SanitizedBranding } from './types.js';
import {
  buildSunatQrPayload,
  documentTypeLabel,
  mergeBranding,
  money,
} from './sunat-qr.js';
import { validateAndSanitizeCpe, CpeValidationError } from './cpe-validator.js';
import {
  validateAndSanitizeBranding,
  DEFAULT_TICKET_LOGO_FIT,
  sanitizeLogoFit,
} from './branding-validator.js';

type PdfDoc = InstanceType<typeof PDFDocument>;
const INK = '#1F2937';
const MUTED = '#64748B';
const LINE = '#CBD5E1';
const PALE = '#F1F5F9';
const PAGE_WIDTH = 595.28;
const A4_LEFT = 38;
const A4_RIGHT = 38;
const A4_CONTENT = PAGE_WIDTH - A4_LEFT - A4_RIGHT;

export class CpePrintService {
  async render(cpe: PrintableCpe, format: PrintFormat, options?: PrintOptions): Promise<Buffer> {
    const validation = validateAndSanitizeCpe(cpe);
    if (!validation.isValid) throw new CpeValidationError(validation.errors, validation.warnings);
    // Siempre generar desde la copia normalizada, sin mutar el comprobante de origen.
    cpe = validation.sanitizedCpe;
    const merged = mergeBranding(cpe, options);
    const { sanitized } = validateAndSanitizeBranding(merged, cpe.issuer);

    const qr = await QRCode.toBuffer(buildSunatQrPayload(cpe), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 280,
    });

    return format === 'a4'
      ? this.renderA4(cpe, qr, sanitized)
      : this.renderTicket(cpe, qr, sanitized);
  }

  private renderA4(
    cpe: PrintableCpe,
    qr: Buffer,
    branding: SanitizedBranding
  ): Promise<Buffer> {
    const primaryColor = branding.primaryColor;
    return this.toBuffer(
      new PDFDocument({
        size: 'A4',
        margins: { top: 34, bottom: 34, left: A4_LEFT, right: A4_RIGHT },
        autoFirstPage: true,
      }) as PdfDoc,
      (doc) => {
        let y = 34;
        this.drawA4Header(doc, cpe, branding, primaryColor, y);
        y += 108;
        y = this.drawA4Customer(doc, cpe, primaryColor, y);
        y += 14;
        y = this.drawA4Items(doc, cpe, primaryColor, y);
        y = this.ensureSpace(doc, y, 145);
        this.drawA4Totals(doc, cpe, primaryColor, y);
        y += 105;

        // Cuentas bancarias comerciales (si están configuradas)
        if (branding.bankAccounts && branding.bankAccounts.length > 0) {
          y = this.ensureSpace(doc, y, 45);
          y = this.drawA4BankAccounts(doc, branding, primaryColor, y);
          y += 10;
        }

        y = this.ensureSpace(doc, y, 120);
        this.drawQrAndHash(doc, cpe, qr, primaryColor, A4_LEFT, y, 86, A4_CONTENT - 100);

        // Pie comercial o garantía
        let footerText = 'Representación impresa del comprobante electrónico. Verifique su validez en los canales oficiales de SUNAT.';
        if (branding.commercialFooter) {
          footerText = `${branding.commercialFooter}\n${footerText}`;
        }
        doc
          .font('Helvetica')
          .fontSize(7)
          .fillColor(MUTED)
          .text(footerText, A4_LEFT, y + 98, { width: A4_CONTENT, align: 'center' });
      }
    );
  }

  private drawA4Header(
    doc: PdfDoc,
    cpe: PrintableCpe,
    branding: SanitizedBranding,
    primaryColor: string,
    y: number
  ): void {
    let textLeft = A4_LEFT;
    let maxTextWidth = 310;

    // Dibujar logo validado si existe
    if (branding.logo) {
      try {
        const [fitW, fitH] = branding.logoFit;
        doc.image(branding.logo, A4_LEFT, y, { fit: [fitW, fitH] });
        textLeft = A4_LEFT + fitW + 12;
        maxTextWidth = 350 - textLeft;
      } catch {
        // En caso de que PDFKit no pueda decodificar la imagen, no frenar el render
      }
    }

    // Nombre y razón social
    const displayName = branding.tradeName || branding.legalName;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(primaryColor).text(displayName, textLeft, y, { width: maxTextWidth });
    let textY = y + 15;

    if (branding.tradeName && branding.tradeName !== branding.legalName) {
      doc.font('Helvetica').fontSize(7.5).fillColor(INK).text(branding.legalName, textLeft, textY, { width: maxTextWidth });
      textY += 10;
    }

    if (branding.slogan) {
      doc.font('Helvetica-Oblique').fontSize(7).fillColor(MUTED).text(`"${branding.slogan}"`, textLeft, textY, { width: maxTextWidth });
      textY += 10;
    }

    const address = branding.commercialAddress;
    if (address) {
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(address, textLeft, textY, { width: maxTextWidth });
      textY += 9;
    }

    // Datos de contacto comercial
    const contactParts: string[] = [];
    if (branding.phone) contactParts.push(`Tel: ${branding.phone}`);
    if (branding.whatsapp) contactParts.push(`WhatsApp: ${branding.whatsapp}`);
    if (contactParts.length) {
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(contactParts.join('  |  '), textLeft, textY, { width: maxTextWidth });
      textY += 9;
    }

    const webParts: string[] = [];
    if (branding.email) webParts.push(branding.email);
    if (branding.website) webParts.push(branding.website);
    if (branding.socialMedia) webParts.push(branding.socialMedia);
    if (webParts.length) {
      doc.font('Helvetica').fontSize(7).fillColor(primaryColor).text(webParts.join('  |  '), textLeft, textY, { width: maxTextWidth });
    }

    // Recuadro RUC y Comprobante
    const bx = 367, by = y, bw = 190, bh = 80;
    doc.lineWidth(1.3).strokeColor(primaryColor).rect(bx, by, bw, bh).stroke();
    doc.rect(bx, by + 24, bw, 25).fill(PALE);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(`R.U.C. ${cpe.issuer.ruc}`, bx + 5, by + 7, { width: bw - 10, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(primaryColor).text(documentTypeLabel(cpe.type), bx + 5, by + 31, { width: bw - 10, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(`${cpe.series}-${cpe.number}`, bx + 5, by + 56, { width: bw - 10, align: 'center' });
  }

  private drawA4Customer(doc: PdfDoc, cpe: PrintableCpe, primaryColor: string, y: number): number {
    const h = 77;
    doc.lineWidth(0.7).strokeColor(LINE).rect(A4_LEFT, y, A4_CONTENT, h).stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(primaryColor).text('DATOS DEL CLIENTE', A4_LEFT + 8, y + 7);
    const rows: Array<[string, string]> = [
      ['Señor(es):', cpe.customer.name],
      ['Documento:', `${cpe.customer.documentType} ${cpe.customer.documentNumber}`],
      ['Dirección:', cpe.customer.address || 'No consignada'],
      ['Emisión / moneda:', `${cpe.issueDate}${cpe.issueTime ? ` ${cpe.issueTime}` : ''} / ${cpe.totals.currency}`],
    ];
    rows.forEach(([label, value], index) => {
      const ry = y + 22 + index * 13;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK).text(label, A4_LEFT + 8, ry, { width: 105 });
      doc.font('Helvetica').fontSize(7.5).fillColor(INK).text(value, A4_LEFT + 114, ry, { width: A4_CONTENT - 125 });
    });
    if (cpe.dueDate || cpe.paymentMethod) {
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(
        [cpe.paymentMethod && `Pago: ${cpe.paymentMethod}`, cpe.dueDate && `Vence: ${cpe.dueDate}`].filter(Boolean).join('  |  '),
        A4_LEFT + 8,
        y + h - 10
      );
    }
    if (cpe.type === '07' && cpe.modifiedDocument) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(primaryColor).text(
        `Comprobante afectado: ${cpe.modifiedDocument.documentType} ${cpe.modifiedDocument.series}-${cpe.modifiedDocument.number}`,
        A4_LEFT,
        y + h + 4,
        { width: A4_CONTENT }
      );
      doc.font('Helvetica').fontSize(7).fillColor(INK).text(
        `Motivo: ${cpe.modifiedDocument.reasonCode} - ${cpe.modifiedDocument.reasonDescription}`,
        A4_LEFT,
        y + h + 15,
        { width: A4_CONTENT }
      );
      return y + h + 34;
    }
    return y + h + 13;
  }

  private drawA4Items(doc: PdfDoc, cpe: PrintableCpe, primaryColor: string, startY: number): number {
    const widths = [44, 42, 226, 72, 78, 57];
    const xs = [A4_LEFT];
    for (const w of widths.slice(0, -1)) xs.push(xs[xs.length - 1] + w);
    const headers = ['CANT.', 'U.M.', 'DESCRIPCIÓN', 'V. UNIT.', 'SUBTOTAL', 'TOTAL'];
    let y = startY;
    const drawHeader = () => {
      doc.rect(A4_LEFT, y, A4_CONTENT, 20).fill(primaryColor);
      headers.forEach((h, i) =>
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#FFFFFF').text(h, xs[i] + 3, y + 6, {
          width: widths[i] - 6,
          align: i < 3 ? 'left' : 'right',
        })
      );
      y += 24;
    };
    drawHeader();
    for (const item of cpe.lines) {
      const descHeight = doc.font('Helvetica').fontSize(7.5).heightOfString(item.description, { width: widths[2] - 8 });
      const rowHeight = Math.max(19, descHeight + 8);
      if (y + rowHeight > 760) {
        doc.addPage();
        y = 36;
        drawHeader();
      }
      doc.font('Helvetica').fontSize(7.5).fillColor(INK);
      const vals = [
        item.quantity.toString(),
        item.unitCode,
        item.description,
        money(item.unitPrice),
        money(item.lineExtensionAmount),
        money(item.totalAmount),
      ];
      vals.forEach((v, i) =>
        doc.text(v, xs[i] + 3, y + 4, {
          width: widths[i] - 6,
          align: i < 3 ? 'left' : 'right',
          height: rowHeight - 4,
        })
      );
      doc.moveTo(A4_LEFT, y + rowHeight).lineTo(A4_LEFT + A4_CONTENT, y + rowHeight).lineWidth(0.5).strokeColor(LINE).stroke();
      y += rowHeight;
    }
    return y + 12;
  }

  private drawA4Totals(doc: PdfDoc, cpe: PrintableCpe, primaryColor: string, y: number): void {
    if (cpe.totals.amountInWords) {
      doc.rect(A4_LEFT, y, A4_CONTENT, 24).fill(PALE);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK).text(`SON: ${cpe.totals.amountInWords}`, A4_LEFT + 7, y + 8, {
        width: A4_CONTENT - 14,
      });
      y += 32;
    }
    const labels: Array<[string, number]> = [
      ['Operación gravada', cpe.totals.taxable],
      ['Operación exonerada', cpe.totals.exempt],
      ['Operación inafecta', cpe.totals.unaffected],
      ['Operación gratuita', cpe.totals.free],
      ['IGV', cpe.totals.igv],
    ];
    const x = A4_LEFT + A4_CONTENT - 205;
    labels.forEach(([label, amount]) => {
      doc.font('Helvetica').fontSize(8).fillColor(INK).text(`${label}:`, x, y, { width: 125, align: 'right' });
      doc.text(money(amount, cpe.totals.currency), x + 132, y, { width: 73, align: 'right' });
      y += 13;
    });
    doc.moveTo(x, y).lineTo(x + 205, y).lineWidth(1).strokeColor(primaryColor).stroke();
    y += 5;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(primaryColor).text('IMPORTE TOTAL:', x, y, { width: 125, align: 'right' });
    doc.text(money(cpe.totals.total, cpe.totals.currency), x + 132, y, { width: 73, align: 'right' });
  }

  private drawA4BankAccounts(
    doc: PdfDoc,
    branding: SanitizedBranding,
    primaryColor: string,
    y: number
  ): number {
    const accounts = branding.bankAccounts;
    if (!accounts.length) return y;

    const boxH = 20 + accounts.length * 13;
    doc.lineWidth(0.6).strokeColor(LINE).rect(A4_LEFT, y, A4_CONTENT, boxH).stroke();
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(primaryColor).text('CUENTAS BANCARIAS COMERCIALES', A4_LEFT + 8, y + 5);

    accounts.forEach((acc, i) => {
      const rowY = y + 17 + i * 13;
      const desc = `${acc.bank} (${acc.currency})${acc.accountType ? ` - ${acc.accountType}` : ''}: Cta. ${acc.accountNumber}${acc.cci ? ` | CCI: ${acc.cci}` : ''}`;
      doc.font('Helvetica').fontSize(7).fillColor(INK).text(desc, A4_LEFT + 8, rowY, { width: A4_CONTENT - 16 });
    });

    return y + boxH;
  }

  private drawQrAndHash(
    doc: PdfDoc,
    cpe: PrintableCpe,
    qr: Buffer,
    primaryColor: string,
    x: number,
    y: number,
    qrSize: number,
    textWidth: number
  ): void {
    doc.image(qr, x, y, { width: qrSize, height: qrSize });
    const tx = x + qrSize + 12;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(primaryColor).text('Hash CPE', tx, y + 3);
    doc.font('Courier').fontSize(7).fillColor(INK).text(cpe.hashCpe, tx, y + 17, { width: textWidth, lineBreak: true });
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text('Escanee el código QR para consultar los datos del comprobante.', tx, y + 43, { width: textWidth });
  }

  private renderTicket(
    cpe: PrintableCpe,
    qr: Buffer,
    branding: SanitizedBranding
  ): Promise<Buffer> {
    const width = 226.77; // 80 mm in points
    const accountsCount = branding.bankAccounts.length;
    const baseHeight = 420 + (branding.logo ? 45 : 0) + (accountsCount * 18);
    const estimatedHeight = Math.max(
      baseHeight,
      baseHeight + cpe.lines.reduce((sum, line) => sum + 39 + Math.ceil(line.description.length / 28) * 9, 0)
    );

    return this.toBuffer(
      new PDFDocument({
        size: [width, estimatedHeight],
        margins: { top: 12, bottom: 12, left: 10, right: 10 },
      }) as PdfDoc,
      (doc) => {
        const left = 10, content = width - 20;
        let y = 14;

        const centered = (text: string, size = 8, bold = false, color = INK) => {
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color).text(text, left, y, { width: content, align: 'center' });
          y += size + 5;
        };
        const rule = () => {
          doc.moveTo(left, y).lineTo(width - left, y).dash(2, { space: 2 }).lineWidth(0.6).strokeColor(MUTED).stroke().undash();
          y += 9;
        };

        // Logo centrado en el ticket
        if (branding.logo) {
          try {
            const ticketFit = sanitizeLogoFit(branding.logoFit, DEFAULT_TICKET_LOGO_FIT);
            const logoW = Math.min(ticketFit[0], 120);
            const logoH = Math.min(ticketFit[1], 50);
            doc.image(branding.logo, (width - logoW) / 2, y, { fit: [logoW, logoH], align: 'center' });
            y += logoH + 4;
          } catch {
            // bypass logo failure
          }
        }

        const trade = branding.tradeName || cpe.issuer.tradeName;
        if (trade) {
          centered(trade, 9.5, true);
          centered(cpe.issuer.legalName, 7.5);
        } else {
          centered(cpe.issuer.legalName, 9, true);
        }

        if (branding.slogan) {
          centered(`"${branding.slogan}"`, 7, false, MUTED);
        }

        centered(`R.U.C. ${cpe.issuer.ruc}`, 8);
        const addr = branding.commercialAddress;
        if (addr) centered(addr, 7);

        const contactLine = [branding.phone, branding.whatsapp && `Wsp: ${branding.whatsapp}`].filter(Boolean).join(' | ');
        if (contactLine) centered(contactLine, 7);
        if (branding.website) centered(branding.website, 7, false, MUTED);

        rule();
        centered(documentTypeLabel(cpe.type), 9, true);
        centered(`${cpe.series}-${cpe.number}`, 10, true);
        rule();

        const leftLine = (label: string, value: string) => {
          doc.font('Helvetica-Bold').fontSize(7).fillColor(INK).text(label, left, y, { width: 62 });
          doc.font('Helvetica').fontSize(7).text(value, left + 62, y, { width: content - 62 });
          y += Math.max(11, doc.heightOfString(value, { width: content - 62 }) + 3);
        };

        leftLine('FECHA:', `${cpe.issueDate}${cpe.issueTime ? ` ${cpe.issueTime}` : ''}`);
        leftLine('CLIENTE:', cpe.customer.name);
        leftLine('DOC.:', `${cpe.customer.documentType} ${cpe.customer.documentNumber}`);
        if (cpe.customer.address) leftLine('DIRECCIÓN:', cpe.customer.address);
        if (cpe.type === '07' && cpe.modifiedDocument) {
          leftLine('AFECTA:', `${cpe.modifiedDocument.documentType} ${cpe.modifiedDocument.series}-${cpe.modifiedDocument.number}`);
          leftLine('MOTIVO:', `${cpe.modifiedDocument.reasonCode} - ${cpe.modifiedDocument.reasonDescription}`);
        }
        leftLine('MONEDA:', cpe.totals.currency);
        if (cpe.paymentMethod) leftLine('PAGO:', cpe.paymentMethod);
        rule();

        for (const item of cpe.lines) {
          doc.font('Helvetica').fontSize(7).fillColor(INK).text(item.description, left, y, { width: content });
          y += doc.heightOfString(item.description, { width: content }) + 3;
          doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(`${item.quantity} ${item.unitCode} x ${money(item.unitPrice, cpe.totals.currency)}`, left, y, { width: content - 70 });
          doc.font('Helvetica-Bold').fontSize(7).fillColor(INK).text(money(item.totalAmount, cpe.totals.currency), left + content - 70, y, { width: 70, align: 'right' });
          y += 12;
        }
        rule();

        const totalLine = (label: string, value: number, bold = false) => {
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 8 : 7).fillColor(INK).text(label, left, y, { width: content - 78 });
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 8 : 7).text(money(value, cpe.totals.currency), left + content - 78, y, { width: 78, align: 'right' });
          y += bold ? 14 : 11;
        };

        totalLine('Op. gravada', cpe.totals.taxable);
        totalLine('Op. exonerada', cpe.totals.exempt);
        totalLine('Op. inafecta', cpe.totals.unaffected);
        totalLine('IGV', cpe.totals.igv);
        totalLine('TOTAL A PAGAR', cpe.totals.total, true);

        if (cpe.totals.amountInWords) {
          y += 2;
          centered(`SON: ${cpe.totals.amountInWords}`, 6.5);
        }

        // Cuentas bancarias comerciales en ticket
        if (branding.bankAccounts && branding.bankAccounts.length > 0) {
          rule();
          centered('CUENTAS BANCARIAS', 7, true);
          branding.bankAccounts.forEach((acc) => {
            const accLine = `${acc.bank}: ${acc.accountNumber}${acc.cci ? ` (CCI: ${acc.cci})` : ''}`;
            centered(accLine, 6.5);
          });
        }

        rule();
        const qrSize = 92;
        doc.image(qr, (width - qrSize) / 2, y, { width: qrSize, height: qrSize });
        y += qrSize + 5;

        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(INK).text('HASH CPE', left, y, { width: content, align: 'center' });
        y += 9;
        doc.font('Courier').fontSize(6).fillColor(INK).text(cpe.hashCpe, left, y, { width: content, align: 'center' });
        y += 13;

        if (branding.commercialFooter) {
          centered(branding.commercialFooter, 6.5, false, INK);
        }

        centered('Representación impresa del comprobante electrónico', 6.5);
        centered('Consulte su validez en los canales oficiales de SUNAT', 6.5);
      }
    );
  }

  private ensureSpace(doc: PdfDoc, y: number, needed: number): number {
    if (y + needed > 790) {
      doc.addPage();
      return 36;
    }
    return y;
  }

  private toBuffer(doc: PdfDoc, draw: (doc: PdfDoc) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      try {
        draw(doc);
        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }
}
