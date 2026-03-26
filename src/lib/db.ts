import { Client } from "pg";

function getClient() {
  const cert = process.env.DB_SSL_CERT
    ? Buffer.from(process.env.DB_SSL_CERT, "base64").toString()
    : undefined;
  const key = process.env.DB_SSL_KEY
    ? Buffer.from(process.env.DB_SSL_KEY, "base64").toString()
    : undefined;

  const connStr = `postgresql://${process.env.DB_USER}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;

  return new Client({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false, cert, key },
    connectionTimeoutMillis: 15000,
  });
}

export async function query(sql: string) {
  const client = getClient();
  try {
    await client.connect();
    const result = await client.query(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

export async function queryParams(sql: string, params: unknown[]) {
  const client = getClient();
  try {
    await client.connect();
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}
