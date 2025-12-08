import { getConstants, init } from '@paralleldrive/cuid2'

/**
 * Gera um ID único
 * @param length - O comprimento do ID
 * @returns Um ID único
 */
export const generateId = (length?: number) => {
  const constants = getConstants()

  const id = init({
    length: length ?? constants.defaultLength,
  })

  return id()
}
