/**
 * Conversor de importes monetarios a texto en español para comprobantes peruanos.
 * Cumple con el formato requerido en la leyenda UBL 2.1 (Código 1000 - Monto en letras).
 * Ejemplo: "SON: CIENTO DIECIOCHO CON 50/100 SOLES"
 */

const UNIDADES = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
const DECENAS = [
  '',
  'DIEZ',
  'VEINTE',
  'TREINTA',
  'CUARENTA',
  'CINCUENTA',
  'SESENTA',
  'SETENTA',
  'OCHENTA',
  'NOVENTA',
];
const ESPECIALES_10: Record<number, string> = {
  11: 'ONCE',
  12: 'DOCE',
  13: 'TRECE',
  14: 'CATORCE',
  15: 'QUINCE',
  16: 'DIECISEIS',
  17: 'DIECISIETE',
  18: 'DIECIOCHO',
  19: 'DIECINUEVE',
};
const ESPECIALES_20: Record<number, string> = {
  21: 'VEINTIUN',
  22: 'VEINTIDOS',
  23: 'VEINTITRES',
  24: 'VEINTICUATRO',
  25: 'VEINTICINCO',
  26: 'VEINTISEIS',
  27: 'VEINTISIETE',
  28: 'VEINTIOCHO',
  29: 'VEINTINUEVE',
};
const CENTENAS = [
  '',
  'CIENTO',
  'DOSCIENTOS',
  'TRESCIENTOS',
  'CUATROCIENTOS',
  'QUINIENTOS',
  'SEISCIENTOS',
  'SETECIENTOS',
  'OCHOCIENTOS',
  'NOVECIENTOS',
];

function convertirGrupo(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'CIEN';

  const c = Math.floor(n / 100);
  const d = Math.floor((n % 100) / 10);
  const u = n % 10;

  let texto = '';

  if (c > 0) {
    texto += CENTENAS[c] + ' ';
  }

  const resto = n % 100;
  if (resto >= 11 && resto <= 19) {
    texto += ESPECIALES_10[resto];
    return texto.trim();
  }

  if (resto >= 21 && resto <= 29) {
    texto += ESPECIALES_20[resto];
    return texto.trim();
  }

  if (d > 0) {
    texto += DECENAS[d];
    if (u > 0) {
      texto += ' Y ' + UNIDADES[u];
    }
  } else if (u > 0) {
    texto += UNIDADES[u];
  }

  return texto.trim();
}

export function numberToWordsPeru(amount: number | string, currency: 'PEN' | 'USD' = 'PEN'): string {
  const num = typeof amount === 'number' ? amount : parseFloat(amount);
  if (isNaN(num)) return 'SON: CERO CON 00/100 SOLES';

  const absNum = Math.abs(num);
  const entero = Math.floor(absNum);
  const centavos = Math.round((absNum - entero) * 100);
  const centavosStr = centavos.toString().padStart(2, '0');

  let monedaNombre = currency === 'USD' ? 'DÓLARES AMERICANOS' : 'SOLES';

  if (entero === 0) {
    return `SON: CERO CON ${centavosStr}/100 ${monedaNombre}`;
  }

  const millones = Math.floor(entero / 1000000);
  const miles = Math.floor((entero % 1000000) / 1000);
  const unidades = entero % 1000;

  const partes: string[] = [];

  if (millones > 0) {
    if (millones === 1) {
      partes.push('UN MILLÓN');
    } else {
      partes.push(`${convertirGrupo(millones)} MILLONES`);
    }
  }

  if (miles > 0) {
    if (miles === 1) {
      partes.push('MIL');
    } else {
      partes.push(`${convertirGrupo(miles)} MIL`);
    }
  }

  if (unidades > 0) {
    partes.push(convertirGrupo(unidades));
  }

  const textoEntero = partes.join(' ').trim();
  return `SON: ${textoEntero} CON ${centavosStr}/100 ${monedaNombre}`;
}
