// app/api/documents/upload/route.ts
//
// Lets a visitor attach a PDF/DOCX/image to a chat conversation. The file
// is extracted, chunked, and embedded into the isolated
// user_documents/user_document_chunks tables (sql/user_documents_setup.sql)
// via lib/userDocuments.ts, scoped to one conversationId - from then on,
// app/api/rag-chat/route.ts merges those chunks into retrieval for every
// question asked in that same conversation, alongside the shared corpus.
//
// If no conversationId is supplied (first upload in a brand-new chat),
// this creates one and returns it so the frontend can attach it to the
// conversation before the first chat message is even sent.

import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { ingestUserDocument, MAX_USER_DOC_BYTES } from "@/lib/userDocuments";

export const runtime = "nodejs";

async function ensureConversationForUpload(
  visitorId: string,
  requestedConversationId: string,
  filename: string
): Promise<string | null> {
  const supabase = getSupabase();

  if (requestedConversationId) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, visitor_id")
      .eq("id", requestedConversationId)
      .maybeSingle();

    if (!error && data && (!visitorId || data.visitor_id === visitorId)) {
      return requestedConversationId;
    }
    // Stale/mismatched id - fall through and start a fresh conversation
    // rather than failing the upload outright.
  }

  const { data, error } = await supabase
    .from("conversations")
    .insert({
      visitor_id: visitorId || "anonymous",
      title: filename.trim().slice(0, 60) || "New conversation",
    })
    .select("id")
    .single();

  if (error || !data) return null;
  return data.id;
}

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { success: false, error: "Expected multipart/form-data" },
        { status: 400 }
      );
    }

    const form = await req.formData();
    const file = form.get("file") as File | null;
    const visitorId = String(form.get("visitorId") || "").trim();
    const requestedConversationId = String(form.get("conversationId") || "").trim();

    if (!file) {
      return NextResponse.json(
        { success: false, error: "No file provided" },
        { status: 400 }
      );
    }

    if (file.size > MAX_USER_DOC_BYTES) {
      return NextResponse.json(
        {
          success: false,
          error: `File is too large (max ${Math.floor(MAX_USER_DOC_BYTES / (1024 * 1024))}MB)`,
        },
        { status: 400 }
      );
    }

    const conversationId = await ensureConversationForUpload(
      visitorId,
      requestedConversationId,
      file.name
    );

    if (!conversationId) {
      return NextResponse.json(
        { success: false, error: "Failed to create or resolve conversation" },
        { status: 500 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const result = await ingestUserDocument({
      conversationId,
      visitorId: visitorId || null,
      filename: file.name,
      mimeType: file.type,
      buffer,
    });

    if (result.status === "failed") {
      return NextResponse.json(
        {
          success: false,
          conversationId,
          error: result.error || "Failed to process document",
        },
        { status: 422 }
      );
    }

    return NextResponse.json({
      success: true,
      conversationId,
      document: {
        id: result.documentId,
        filename: result.filename,
        fileType: result.fileType,
        chunkCount: result.chunkCount,
      },
    });
  } catch (err: any) {
    console.error("POST /api/documents/upload failed:", err);
    return NextResponse.json(
      { success: false, error: err?.message || "Upload failed" },
      { status: 500 }
    );
  }
}
