import { FastifyRequest, FastifyReply } from "fastify";

/**
 * Check if the client connection is still active
 */
export function isClientConnected(request: FastifyRequest): boolean {
  try {
    const socket = request.raw;
    return socket && !socket.destroyed && !socket.readableEnded;
  } catch (error) {
    // If we can't check the connection, assume it's disconnected
    return false;
  }
}

/**
 * Safely send a response only if the client is still connected
 */
export function safeSend(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  data: any
): void {
  if (!reply.sent && isClientConnected(request)) {
    reply.code(statusCode).send(data);
  }
}

/**
 * Check if an error is related to connection issues
 */
export function isConnectionError(error: Error): boolean {
  if (!error) return false;

  const connectionErrors = [
    "premature close",
    "ECONNRESET",
    "EPIPE",
    "ECONNABORTED",
    "ENOTCONN",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "Client disconnected",
    "socket hang up",
    "Connection lost",
    "Request aborted",
    "write EPIPE",
  ];

  const errorMessage = error.message?.toLowerCase() || "";
  const errorCode = (error as any)?.code?.toUpperCase() || "";

  return connectionErrors.some(
    (errorType) =>
      errorMessage.includes(errorType.toLowerCase()) ||
      errorCode === errorType.toUpperCase()
  );
}

/**
 * Wrapper for async route handlers that handles connection errors
 */
export function withConnectionHandling(
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Early connection check
      if (!isClientConnected(request)) {
        return;
      }

      await handler(request, reply);
    } catch (error) {
      // Don't send error response if client disconnected or it's a connection error
      if (isConnectionError(error as Error) || !isClientConnected(request)) {
        // Log connection errors for debugging but don't treat as application errors
        request.log.debug("Connection error handled gracefully");
        return;
      }

      // Regular error handling for application errors
      request.log.error("Application error occurred");

      if (!reply.sent && isClientConnected(request)) {
        safeSend(reply, request, 500, {
          success: false,
          message: "Erro interno do servidor",
          error: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    }
  };
}
