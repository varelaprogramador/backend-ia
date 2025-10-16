import type { FastifyInstance } from "fastify";
import { StatusCodes } from "http-status-codes";
import { logError, logInfo } from "@/utils/logger";
import { db } from "@/lib/db";
import axios from "axios";
import { ENV } from "@/config/env";

export default async function (app: FastifyInstance) {
  // Transcribe audio using OpenAI Whisper
  app.post<{
    Body: {
      audioBase64: string;
      language?: string;
    };
  }>("/", async (req, reply) => {
    try {
      const { audioBase64, language } = req.body;

      if (!audioBase64) {
        return reply.code(StatusCodes.BAD_REQUEST).send({
          status: "error",
          message: "audioBase64 is required",
        });
      }

      logInfo("Transcribing audio with OpenAI Whisper", {
        audioSize: `${Math.round(audioBase64.length / 1024)}KB`,
        language: language || "auto-detect",
      });

      // Check if OpenAI API key is configured
      if (!ENV.OPENAI_API_KEY) {
        logError("OpenAI API key not configured", new Error("OPENAI_API_KEY is missing"));
        return reply.code(StatusCodes.SERVICE_UNAVAILABLE).send({
          status: "error",
          message: "Transcription service not configured",
        });
      }

      // Convert base64 to buffer
      const audioBuffer = Buffer.from(audioBase64, "base64");

      // Create FormData for OpenAI Whisper API
      const FormData = require("form-data");
      const form = new FormData();
      form.append("file", audioBuffer, {
        filename: "audio.ogg",
        contentType: "audio/ogg",
      });
      form.append("model", "whisper-1");
      if (language) {
        form.append("language", language);
      }

      // Call OpenAI Whisper API
      const response = await axios.post(
        "https://api.openai.com/v1/audio/transcriptions",
        form,
        {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${ENV.OPENAI_API_KEY}`,
          },
          timeout: 60000, // 60 seconds timeout
        }
      );

      const transcription = response.data?.text || "";

      logInfo("Audio transcribed successfully", {
        transcriptionLength: transcription.length,
        transcriptionPreview: transcription.substring(0, 100),
      });

      return reply.code(StatusCodes.OK).send({
        status: "success",
        message: "Audio transcribed successfully",
        data: {
          transcription,
          language: response.data?.language || language || "unknown",
        },
      });
    } catch (error) {
      logError("Error transcribing audio", error as Error);

      // Log detailed error information
      if (axios.isAxiosError(error)) {
        logError("OpenAI API error details", {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
        } as any);
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        status: "error",
        message: "Failed to transcribe audio",
        error: error instanceof Error ? error.message : "Unknown error",
        details: axios.isAxiosError(error) ? error.response?.data : undefined,
      });
    }
  });
}
