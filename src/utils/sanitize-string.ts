/**
 * Sanitiza uma string, removendo caracteres especiais e espaços
 * @param str - A string a ser sanitizada
 * @returns A string sanitizada
 */
export const sanitizeString = (str: string) =>
  str
    .normalize('NFD')
    .replace(/[^\u0000-\u007F]/g, '')
    .replace(/[^a-zA-Z0-9\-\.]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
