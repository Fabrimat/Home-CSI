-- Enables the TimescaleDB extension. Everything else in this schema
-- (hypertables, chunking) depends on it being present first.
CREATE EXTENSION IF NOT EXISTS timescaledb;
