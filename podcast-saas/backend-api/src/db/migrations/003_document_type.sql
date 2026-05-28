-- Migration 003: add 'document' to corpus_source_type enum
ALTER TYPE corpus_source_type ADD VALUE IF NOT EXISTS 'document';
