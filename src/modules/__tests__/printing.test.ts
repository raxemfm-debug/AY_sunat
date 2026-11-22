import { describe, expect, it } from 'vitest';
import {
  CpePrintService,
  buildSunatQrPayload,
  mergeBranding,
  resolveLogoBuffer,
  validatePrintableCpe,
  validateAndSanitizeBranding,
  sanitizeColor,
  detectLogoFormat,
  resolveAndValidateLogo,
  sanitizeLogoFit,
  sanitizeBankAccount,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_ACCENT_COLOR,
  type PrintableCpe,
} from '../printing/index.js';

// Minimal 1x1 transparent PNG for testing
const SAMPLE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SAMPLE_PNG_DATA_URI = `data:image/png;base64,${SAMPLE_PNG_BASE64}`;

// Minimal JPEG header for testing
const SAMPLE_JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const sample = (type: PrintableCpe['type'] = '01'): PrintableCpe => ({
  type,
  series: type === '03' ? 'B001' : 'F001',
  number: '00000042',
  issueDate: '2026-11-21',
  issueTime: '10:15:00',
  issuer: {
    ruc: '20123456789',
    legalName: 'COMERCIAL ANDINA S.A.C.',
    tradeName: 'ANDINA STORE',
    address: 'Av. Principal 123, Lima',
    phone: '(01) 234-5678',
    email: 'contacto@andinastore.pe',
  },
  customer: {
    documentType: type === '03' ? '1' : '6',
    documentNumber: type === '03' ? '12345678' : '20987654321',
    name: 'CLIENTE DE PRUEBA S.A.C.',
  },
  lines: [
    {
      quantity: 2,
      unitCode: 'NIU',
      description: 'Producto de prueba',
      unitValue: 50,
      unitPrice: 59,
      lineExtensionAmount: 100,
      igvAmount: 18,
      totalAmount: 118,
    },
  ],
  totals: {
    taxable: 100,
    exempt: 0,
    unaffected: 0,
    free: 0,
    igv: 18,
    total: 118,
    currency: 'PEN',
    amountInWords: 'CIENTO DIECIOCHO CON 00/100 SOLES',
  },
  hashCpe: 'HASH_DE_PRUEBA_NO_USAR_EN_PRODUCCION',
  ...(type === '07'
    ? {
        modifiedDocument: {
          documentType: '01',
          series: 'F001',
          number: '00000001',
          reasonCode: '01',
          reasonDescription: 'Anulación de la operación',
        },
      }
    : {}),
});

describe('representación impresa CPE con logo y branding comercial', () => {
  it.each(['01', '03', '07'] as const)('genera QR tributario para tipo %s con hash CPE', (type) => {
    const cpe = sample(type);
    expect(buildSunatQrPayload(cpe)).toBe(
      `20123456789|${type}|${cpe.series}|00000042|18.00|118.00|2026-11-21|${cpe.customer.documentType}|${cpe.customer.documentNumber}|${cpe.hashCpe}|`
    );
  });

  it('usa el payload QR exacto entregado por la emisión', () => {
    const cpe = { ...sample(), qrPayload: 'payload-oficial|exacto|' };
    expect(buildSunatQrPayload(cpe)).toBe('payload-oficial|exacto|');
  });

  it('rechaza hash ausente y nota de crédito sin referencia', () => {
    expect(() => validatePrintableCpe({ ...sample(), hashCpe: ' ' })).toThrow(/hashCpe/);
    expect(() => validatePrintableCpe({ ...sample('07'), modifiedDocument: undefined })).toThrow(/referencia/);
  });

  it.each(['a4', 'ticket-80mm'] as const)('genera PDF %s estándar sin branding', async (format) => {
    const pdf = await new CpePrintService().render(sample('03'), format);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it('genera A4 de nota de crédito con referencia al comprobante afectado', async () => {
    const pdf = await new CpePrintService().render(sample('07'), 'a4');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('resuelve correctamente logos en Buffer y Data URI Base64', () => {
    const buf = Buffer.from(SAMPLE_PNG_BASE64, 'base64');
    expect(resolveLogoBuffer(buf)).toEqual(buf);
    expect(resolveLogoBuffer(SAMPLE_PNG_DATA_URI)?.length).toBe(buf.length);
    expect(resolveLogoBuffer({ source: SAMPLE_PNG_DATA_URI })?.length).toBe(buf.length);
    expect(resolveLogoBuffer(undefined)).toBeNull();
  });

  it('fusiona branding de CPE con opciones de impresión', () => {
    const cpe = sample('01');
    cpe.branding = { tradeName: 'TIENDA BASE', slogan: 'Slogan Base' };
    const merged = mergeBranding(cpe, {
      branding: { slogan: 'Slogan Sobrescrito', whatsapp: '+51999888777' },
    });
    expect(merged.tradeName).toBe('TIENDA BASE');
    expect(merged.slogan).toBe('Slogan Sobrescrito');
    expect(merged.whatsapp).toBe('+51999888777');
  });

  it('genera factura A4 completa con logo, colores corporativos y cuentas bancarias', async () => {
    const cpe = sample('01');
    cpe.branding = {
      logo: { source: SAMPLE_PNG_DATA_URI, fit: [120, 50] },
      primaryColor: '#047857',
      tradeName: 'ANDINA TECH STORE',
      slogan: 'Tecnología y Soluciones Empresariales',
      commercialAddress: 'Av. Las Begonias 450, San Isidro, Lima',
      phone: '(01) 456-7890',
      whatsapp: '+51 987 654 321',
      email: 'facturacion@andinatech.pe',
      website: 'www.andinatech.pe',
      bankAccounts: [
        {
          bank: 'BCP',
          currency: 'PEN',
          accountType: 'Corriente',
          accountNumber: '191-12345678-0-99',
          cci: '00219100123456780099',
        },
        {
          bank: 'BBVA',
          currency: 'USD',
          accountType: 'Corriente',
          accountNumber: '0011-0123-0100012345',
          cci: '01112300010001234599',
        },
      ],
      commercialFooter: 'Garantía oficial de 12 meses. Consulte políticas de cambio en nuestra web.',
    };

    const pdf = await new CpePrintService().render(cpe, 'a4');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);
  });

  it('genera ticket 80mm completo con logo, datos comerciales y cuentas bancarias', async () => {
    const cpe = sample('03');
    cpe.branding = {
      logo: Buffer.from(SAMPLE_PNG_BASE64, 'base64'),
      tradeName: 'MINIMARKET DON PEPE',
      slogan: 'Los mejores precios siempre',
      phone: '987654321',
      whatsapp: '987654321',
      bankAccounts: [
        {
          bank: 'YAPE / BCP',
          currency: 'PEN',
          accountNumber: '987654321',
        },
      ],
      commercialFooter: '¡Gracias por su preferencia!',
    };

    const pdf = await new CpePrintService().render(cpe, 'ticket-80mm');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1500);
  });

  // --- Pruebas de validación y fallbacks seguros ---

  describe('validación de colores y fallbacks seguros', () => {
    it('acepta colores hexadecimales válidos de 6 y 3 caracteres normalizados', () => {
      expect(sanitizeColor('#17365D', DEFAULT_PRIMARY_COLOR)).toEqual({
        color: '#17365D',
        isFallback: false,
      });
      expect(sanitizeColor('#abc', DEFAULT_PRIMARY_COLOR)).toEqual({
        color: '#AABBCC',
        isFallback: false,
      });
      expect(sanitizeColor('#ff0055', DEFAULT_PRIMARY_COLOR)).toEqual({
        color: '#FF0055',
        isFallback: false,
      });
    });

    it('asigna valor seguro por defecto cuando el color es inválido, vacío o no es string', () => {
      expect(sanitizeColor('rojo', DEFAULT_PRIMARY_COLOR)).toEqual({
        color: DEFAULT_PRIMARY_COLOR,
        isFallback: true,
      });
      expect(sanitizeColor('#12', DEFAULT_PRIMARY_COLOR)).toEqual({
        color: DEFAULT_PRIMARY_COLOR,
        isFallback: true,
      });
      expect(sanitizeColor('#ZZZZZZ', DEFAULT_ACCENT_COLOR)).toEqual({
        color: DEFAULT_ACCENT_COLOR,
        isFallback: true,
      });
      expect(sanitizeColor(null, DEFAULT_PRIMARY_COLOR)).toEqual({
        color: DEFAULT_PRIMARY_COLOR,
        isFallback: true,
      });
      expect(sanitizeColor(12345, DEFAULT_ACCENT_COLOR)).toEqual({
        color: DEFAULT_ACCENT_COLOR,
        isFallback: true,
      });
    });
  });

  describe('validación de formatos de logo y dimensiones seguras', () => {
    it('detecta correctamente formato PNG y JPEG mediante magic bytes', () => {
      const pngBuf = Buffer.from(SAMPLE_PNG_BASE64, 'base64');
      expect(detectLogoFormat(pngBuf)).toBe('png');
      expect(detectLogoFormat(SAMPLE_JPEG_BUFFER)).toBe('jpeg');
      expect(detectLogoFormat(Buffer.from('texto plano no imagen'))).toBeNull();
    });

    it('rechaza de forma segura formatos no soportados como SVG o texto', () => {
      const svgData = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
      const result = resolveAndValidateLogo(svgData);
      expect(result.buffer).toBeNull();
      expect(result.format).toBeNull();
      expect(result.warning).toMatch(/no soportado/);
    });

    it('rechaza de forma segura rutas inexistentes sin lanzar error', () => {
      const result = resolveAndValidateLogo('/ruta/inexistente/logo.png');
      expect(result.buffer).toBeNull();
      expect(result.warning).toMatch(/No se pudo leer/);
    });

    it('normaliza dimensiones de ajuste (fit) inválidas a valores seguros', () => {
      expect(sanitizeLogoFit([150, 80])).toEqual([150, 80]);
      expect(sanitizeLogoFit([-50, 100])).toEqual([110, 58]);
      expect(sanitizeLogoFit([NaN, 100])).toEqual([110, 58]);
      expect(sanitizeLogoFit('invalido')).toEqual([110, 58]);
    });
  });

  describe('validación de datos comerciales y sanitización integral', () => {
    it('depura cuentas bancarias y descarta entradas incompletas', () => {
      const valid = sanitizeBankAccount({
        bank: 'BCP',
        currency: 'PEN',
        accountNumber: '191-12345678-0',
        accountType: 'Corriente',
      });
      expect(valid?.bank).toBe('BCP');
      expect(valid?.currency).toBe('PEN');

      // Entrada sin banco o sin número se descarta
      expect(sanitizeBankAccount({ bank: '', accountNumber: '123' })).toBeNull();
      expect(sanitizeBankAccount({ bank: 'BCP', accountNumber: '' })).toBeNull();
      expect(sanitizeBankAccount(null)).toBeNull();
    });

    it('valida datos comerciales, detecta advertencias y usa fallbacks seguros', () => {
      const res = validateAndSanitizeBranding(
        {
          primaryColor: 'color-invalido',
          accentColor: '#1234567',
          logo: Buffer.from('contenido corrupto que no es imagen'),
          email: 'correo-sin-arroba',
          phone: 'telefono????invalido@@@',
          whatsapp: '987654321',
          website: 'https://miempresa.com',
          bankAccounts: [
            { bank: 'Interbank', currency: 'PEN', accountNumber: '200-123456' },
            { bank: '', currency: 'PEN', accountNumber: '' }, // se descarta
          ],
        },
        {
          ruc: '20123456789',
          legalName: 'EMPRESA FISCAL S.A.C.',
          phone: '(01) 333-4444',
          email: 'fiscal@empresa.com',
        }
      );

      expect(res.isValid).toBe(false);
      expect(res.warnings.length).toBeGreaterThanOrEqual(4);
      // Fallback seguro de colores
      expect(res.sanitized.primaryColor).toBe(DEFAULT_PRIMARY_COLOR);
      expect(res.sanitized.accentColor).toBe(DEFAULT_ACCENT_COLOR);
      // Logo corrupto omitido de forma segura
      expect(res.sanitized.logo).toBeNull();
      // Email inválido recurre al fiscal del emisor
      expect(res.sanitized.email).toBe('fiscal@empresa.com');
      // Teléfono inválido recurre al del emisor
      expect(res.sanitized.phone).toBe('(01) 333-4444');
      // WhatsApp y website válidos se conservan
      expect(res.sanitized.whatsapp).toBe('987654321');
      expect(res.sanitized.website).toBe('https://miempresa.com');
      // Solo 1 cuenta bancaria válida
      expect(res.sanitized.bankAccounts.length).toBe(1);
    });

    it('renderiza A4 y Ticket con éxito incluso cuando todas las opciones de branding son inválidas', async () => {
      const cpe = sample('01');
      cpe.branding = {
        primaryColor: 'invalido-100%',
        accentColor: '#xyz',
        logo: 'archivo_que_no_existe.xyz',
        email: 'invalido',
        phone: '###',
        bankAccounts: [{ bank: '', currency: 'PEN', accountNumber: '' }],
      };

      const printService = new CpePrintService();
      const a4 = await printService.render(cpe, 'a4');
      const ticket = await printService.render(cpe, 'ticket-80mm');

      expect(a4.subarray(0, 5).toString()).toBe('%PDF-');
      expect(ticket.subarray(0, 5).toString()).toBe('%PDF-');
      expect(a4.length).toBeGreaterThan(1500);
      expect(ticket.length).toBeGreaterThan(1000);
    });
  });
});
