# Motor Tributario Perú — Persona Natural con Negocio en RMT

**Estado:** base de arquitectura ejecutable para desarrollo y pruebas locales. No es un sistema contable completo ni emite CPE válidos para SUNAT. Requiere validación normativa y técnica antes de producción.

## Perfil configurado

- Persona Natural con Negocio, Régimen MYPE Tributario (RMT).
- Tipos CPE contemplados: factura (01), boleta (03) y nota de crédito (07).
- Emisión directa por SEE del contribuyente, aún no conectada.
- Sin detracciones, retenciones/percepciones ni planilla en el alcance inicial.

> El usuario indicó MYPE, pero no confirmó explícitamente el régimen tributario. Este repositorio asume RMT como hipótesis de trabajo y debe verificarse en SUNAT antes de parametrizar cálculos oficiales.

## Estructura

```text
src/core/tax-engine/
  types.ts                 tipos del dominio y catálogos
  tax-config.ts            parámetros tributarios por año
  validators.ts            validaciones iniciales
  cpe-calculator.ts        cálculo preliminar de líneas y totales
  monthly-settlement.ts    preliquidación mensual de IGV y pago a cuenta RMT
  number-to-words.ts       importe en letras
  index.ts                 exports
  __tests__/tax-engine.test.ts
```

## Requisitos

Node.js 20 o superior y npm.

## Empezar en VSCode

1. Descomprime el ZIP y abre la carpeta `peru-tax-engine` en VSCode.
2. En la terminal integrada ejecuta:

```bash
npm install
npm run typecheck
npm test
```

Para compilar TypeScript: `npm run build`.

## Uso básico

```ts
import { calculateMonthlySettlement } from './core/tax-engine/index.js';

const result = calculateMonthlySettlement({
  period: '2026-01',
  accumulatedNetRevenueBeforePeriod: '0',
  salesTaxableBase: '10000.00',
  salesIgv: '1800.00',
  purchasesTaxableBase: '2000.00',
  purchasesIgv: '360.00',
});

console.log(result.totalTributosAPagar);
```

Use strings decimales para importes monetarios; evite pasar previamente por cálculos de punto flotante. `decimal.js` ejecuta las operaciones con precisión decimal.

## Advertencias críticas antes de ampliar

1. **RMT no confirmado:** “Persona Natural con Negocio y MYPE” no basta para determinar el régimen; confirmar RMT con el contribuyente/RUC. El RMT y el Régimen General tienen obligaciones diferentes.
2. **Pago a cuenta mensual incompleto:** el cálculo de pago a cuenta no contempla la comparación con coeficiente cuando corresponde, pagos previos, suspensión/modificación de pagos, retenciones/percepciones ni todos los escenarios de ingresos anuales acumulados. No usar como importe oficial a pagar.
3. **CPE incompleto:** la función genera datos preliminares, no XML UBL 2.1 oficial, firma XMLDSig, ZIP, envío SOAP, CDR, QR ni PDF tributario. No enviar al ambiente de producción.
4. **IGV y descuentos:** descuentos globales, gratuitos y notas de crédito necesitan reglas normativas completas; no aplicar resultado como liquidación oficial.
5. **Conexión SUNAT:** no se implementa autenticación SOL, endpoint ni certificado. Las credenciales/certificados nunca deben residir en frontend ni guardarse en Git.
6. **RUC de prueba:** los datos en las pruebas son ficticios; sustituir por datos verificados y autorizados para uso real.
7. **Normativa:** registrar referencia y vigencia de cada parámetro con revisión profesional; el software no brinda asesoría legal/tributaria.

## Base legal inicial a verificar

- RMT: Decreto Legislativo 1269 y modificatorias.
- IGV: TUO de la Ley del IGV e ISC, D.S. 055-99-EF y modificatorias.
- UIT 2026: S/ 5,500, D.S. 301-2025-EF.
- IGV total: 18% (16% IGV + 2% IPM), sujeto a verificación de tratamiento por operación.
- SEE del contribuyente y CPE: revisar versiones vigentes de resoluciones SUNAT y documentación técnica UBL/CPE antes de integrarlo.

## Próxima fase recomendada

Antes de escribir integración SUNAT, confirmar régimen y perfil RUC, luego investigar fuentes oficiales y diseñar una interfaz `SunatGateway` con ambiente beta/producción, firma aislada, controles de idempotencia, trazabilidad de request/response y almacenamiento seguro de certificados.
