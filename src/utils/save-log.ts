import fs from 'fs'
import path from 'path'

/**
 * Função para salvar logs em um arquivo JSON dentro da pasta "src/logs".
 * @param logEntry Objeto contendo os dados do log.
 * @param filename Nome do arquivo (sem extensão) onde o log será salvo (padrão: "webhook_logs").
 */
export async function saveLog(
  logEntry: object,
  filename: string = 'webhook_logs',
) {
  const logsDir = path.join(process.cwd(), 'src', 'logs') // Caminho para "src/logs"
  const logFilePath = path.join(logsDir, `${filename}.json`) // Adiciona automaticamente a extensão .json

  // Verifica se a pasta "logs" dentro de "src" existe, se não, cria
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }

  fs.readFile(logFilePath, 'utf8', (err, data) => {
    let logs = []

    if (!err && data) {
      try {
        logs = JSON.parse(data) // Tenta parsear o JSON existente
      } catch (parseErr) {
        console.error('Erro ao interpretar JSON do log:', parseErr)
      }
    }

    logs.push(logEntry) // Adiciona o novo log

    fs.writeFile(logFilePath, JSON.stringify(logs, null, 2), writeErr => {
      if (writeErr) {
        console.error('Erro ao salvar o log:', writeErr)
      }
    })
  })
}
