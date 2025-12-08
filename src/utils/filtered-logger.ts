import pino from 'pino';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

const timeZone = 'America/Sao_Paulo';

// Create a custom writable stream that filters out premature close errors
class FilteredLogStream {
  private target: any;

  constructor() {
    this.target = pino.destination({
      sync: false
    });
  }

  write(chunk: string) {
    try {
      const logEntry = JSON.parse(chunk);
      
      // Filter out premature close errors completely
      if (logEntry.level >= 50 && // ERROR level or higher
          (logEntry.err?.message === 'premature close' ||
           logEntry.msg?.includes('premature close') ||
           logEntry.err?.type === 'ClientDisconnectionWarning')) {
        // Don't write premature close errors at all
        return true;
      }
      
      // Write all other log entries
      return this.target.write(chunk);
    } catch (error) {
      // If parsing fails, write the original chunk
      return this.target.write(chunk);
    }
  }

  end() {
    return this.target.end();
  }

  destroy() {
    return this.target.destroy();
  }
}

const filteredStream = new FilteredLogStream();

export const createFilteredFastifyLogger = () => {
  return {
    level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
    timestamp: () => `,"time":"${dayjs().tz(timeZone).format('DD/MM/YYYY HH:mm:ss A')}"`,
    stream: filteredStream,
    serializers: {
      err: (err: any) => {
        // Completely suppress premature close errors
        if (err?.message === 'premature close' || 
            err?.message?.includes('premature close') ||
            err?.type === 'ClientDisconnectionWarning') {
          return undefined; // Don't serialize at all
        }
        return pino.stdSerializers.err(err);
      },
      req: (req: any) => {
        return {
          method: req.method,
          url: req.url,
          headers: {
            host: req.headers?.host,
            'user-agent': req.headers?.['user-agent']?.substring(0, 50),
            'content-type': req.headers?.['content-type']
          }
        };
      },
      res: pino.stdSerializers.res
    },
    // Custom formatters to handle premature close
    formatters: {
      log: (obj: any) => {
        // Filter out premature close at the formatter level too
        if (obj.err?.message === 'premature close' ||
            obj.msg?.includes('premature close')) {
          return {}; // Return empty object to suppress
        }
        return obj;
      }
    }
  };
};