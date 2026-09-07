-- Conversation history: per-browser (no login) saved, resumable chats.
-- Run this once in the Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  -- Anonymous per-browser id (localStorage-generated on the client, see
  -- lib/visitorId.ts). Not a real user account - two browsers on the same
  -- physical machine, or the same browser after clearing site data, get
  -- separate histories. That's an intentional, documented trade-off, not
  -- an oversight: no login system exists in this app.
  visitor_id text not null,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_visitor_id_idx
  on conversations (visitor_id, updated_at desc);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  -- Mirrors ChatMessage['metadata'] in components/chat/ChatInterface.tsx:
  -- citations, confidence, groundedness, unsupportedClaims, diagram,
  -- processingtime. Stored as-is so reopening a saved conversation
  -- restores the exact same message bubble, badges, and source panel.
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_conversation_id_idx
  on chat_messages (conversation_id, created_at asc);

-- No RLS policies: this table is only ever touched server-side through
-- the app's API routes using the Supabase service-role key (which
-- bypasses RLS regardless), and the service-role key is never exposed to
-- the browser. Ownership is enforced in application code by checking
-- visitor_id on every read/write, the same way the rest of this app
-- already handles access without a client-side Supabase key.
