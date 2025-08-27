/**
 * Converte um valor para centavos
 * @param value - O valor a ser convertido
 * @returns O valor em centavos
 */
export const formatCurrencyToCents = (value: number) => {
  return value * 100
}

/**
 * Converte um valor de centavos para reais
 * @param value - O valor em centavos
 * @returns O valor em reais
 */
export const formatCurrencyFromCents = (value: number) => {
  return value / 100
}
