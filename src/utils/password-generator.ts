import crypto from 'node:crypto'

interface PasswordOptions {
  length?: number
  includeUppercase?: boolean
  includeLowercase?: boolean
  includeNumbers?: boolean
  includeSymbols?: boolean
  excludeSimilar?: boolean
  excludeAmbiguous?: boolean
}

const DEFAULT_OPTIONS: Required<PasswordOptions> = {
  length: 12,
  includeUppercase: true,
  includeLowercase: true,
  includeNumbers: true,
  includeSymbols: true,
  excludeSimilar: false,
  excludeAmbiguous: false,
}

const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz'
const NUMBERS = '0123456789'
const SYMBOLS = '!@#$%^&*()_+-=[]{}|;:,.<>?'

// Caracteres ambíguos
const AMBIGUOUS_CHARS = '{}[]()/\\\'"`~,;.<>'

/**
 * Gera uma senha forte baseada nos critérios especificados
 * @param options - Opções para customizar a geração da senha
 * @returns Uma senha forte gerada aleatoriamente
 */
export const generateStrongPassword = (
  options: PasswordOptions = {},
): string => {
  const config = { ...DEFAULT_OPTIONS, ...options }

  if (config.length < 4) {
    throw new Error('Comprimento mínimo da senha deve ser 4 caracteres')
  }

  let charset = ''
  let requiredChars = ''

  // Constrói o conjunto de caracteres baseado nas opções
  if (config.includeUppercase) {
    let uppercaseChars = UPPERCASE
    if (config.excludeSimilar) {
      uppercaseChars = uppercaseChars.replace(/[IL]/g, '')
    }
    charset += uppercaseChars
    requiredChars += getRandomChar(uppercaseChars)
  }

  if (config.includeLowercase) {
    let lowercaseChars = LOWERCASE
    if (config.excludeSimilar) {
      lowercaseChars = lowercaseChars.replace(/[il]/g, '')
    }
    charset += lowercaseChars
    requiredChars += getRandomChar(lowercaseChars)
  }

  if (config.includeNumbers) {
    let numberChars = NUMBERS
    if (config.excludeSimilar) {
      numberChars = numberChars.replace(/[10]/g, '')
    }
    charset += numberChars
    requiredChars += getRandomChar(numberChars)
  }

  if (config.includeSymbols) {
    let symbolChars = SYMBOLS
    if (config.excludeAmbiguous) {
      symbolChars = symbolChars.replace(
        new RegExp(`[${AMBIGUOUS_CHARS.replace(/[[\]\\]/g, '\\$&')}]`, 'g'),
        '',
      )
    }
    charset += symbolChars
    requiredChars += getRandomChar(symbolChars)
  }

  if (charset.length === 0) {
    throw new Error('Pelo menos uma categoria de caracteres deve ser incluída')
  }

  // Gera os caracteres restantes
  const remainingLength = config.length - requiredChars.length
  let password = requiredChars

  for (let i = 0; i < remainingLength; i++) {
    password += getRandomChar(charset)
  }

  // Embaralha a senha para evitar padrões previsíveis
  return shuffleString(password)
}

/**
 * Gera uma senha simples (apenas letras e números, sem símbolos)
 * @param length - Comprimento da senha (padrão: 8)
 * @returns Uma senha simples
 */
export const generateSimplePassword = (length: number = 8): string => {
  return generateStrongPassword({
    length,
    includeUppercase: true,
    includeLowercase: true,
    includeNumbers: true,
    includeSymbols: false,
    excludeSimilar: true,
  })
}

/**
 * Gera uma senha numérica (apenas números)
 * @param length - Comprimento da senha (padrão: 6)
 * @returns Uma senha numérica
 */
export const generateNumericPassword = (length: number = 6): string => {
  return generateStrongPassword({
    length,
    includeUppercase: false,
    includeLowercase: false,
    includeNumbers: true,
    includeSymbols: false,
  })
}

/**
 * Gera uma senha memorável (sem símbolos confusos)
 * @param length - Comprimento da senha (padrão: 10)
 * @returns Uma senha memorável
 */
export const generateMemorablePassword = (length: number = 10): string => {
  return generateStrongPassword({
    length,
    includeUppercase: true,
    includeLowercase: true,
    includeNumbers: true,
    includeSymbols: false,
    excludeSimilar: true,
    excludeAmbiguous: true,
  })
}

/**
 * Avalia a força de uma senha
 * @param password - A senha a ser avaliada
 * @returns Objeto com informações sobre a força da senha
 */
export const evaluatePasswordStrength = (password: string) => {
  const length = password.length
  const hasUppercase = /[A-Z]/.test(password)
  const hasLowercase = /[a-z]/.test(password)
  const hasNumbers = /\d/.test(password)
  const hasSymbols = /[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(password)

  let score = 0
  let feedback: string[] = []

  // Critérios de pontuação
  if (length >= 8) score += 1
  else feedback.push('Use pelo menos 8 caracteres')

  if (length >= 12) score += 1

  if (hasUppercase) score += 1
  else feedback.push('Inclua letras maiúsculas')

  if (hasLowercase) score += 1
  else feedback.push('Inclua letras minúsculas')

  if (hasNumbers) score += 1
  else feedback.push('Inclua números')

  if (hasSymbols) score += 1
  else feedback.push('Inclua símbolos')

  // Verifica repetições
  if (!/(.)\1{2,}/.test(password)) score += 1
  else feedback.push('Evite repetições de caracteres')

  let strength: 'muito-fraca' | 'fraca' | 'media' | 'forte' | 'muito-forte'

  if (score <= 2) strength = 'muito-fraca'
  else if (score <= 3) strength = 'fraca'
  else if (score <= 4) strength = 'media'
  else if (score <= 6) strength = 'forte'
  else strength = 'muito-forte'

  return {
    score,
    strength,
    feedback,
    criteria: {
      length: length >= 8,
      hasUppercase,
      hasLowercase,
      hasNumbers,
      hasSymbols,
    },
  }
}

// Funções auxiliares
const getRandomChar = (charset: string): string => {
  if (charset.length === 0) {
    throw new Error('Conjunto de caracteres não pode estar vazio')
  }

  const randomIndex = crypto.randomInt(0, charset.length)
  const char = charset[randomIndex]

  if (char === undefined) {
    throw new Error('Falha ao gerar caractere aleatório')
  }

  return char
}

const shuffleString = (str: string): string => {
  const array = str.split('')

  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1)
    const temp = array[i]
    const valueJ = array[j]

    if (temp !== undefined && valueJ !== undefined) {
      array[i] = valueJ
      array[j] = temp
    }
  }

  return array.join('')
}
