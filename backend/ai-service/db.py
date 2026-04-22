import os
from psycopg2 import pool
import psycopg2.extras

_pool = None


def get_pool():
    global _pool
    if _pool is None:
        dsn = os.getenv("DATABASE_URL") or os.getenv("DATABASE_URL_AGENT")
        if not dsn:
            raise RuntimeError(
                "[db] nem DATABASE_URL nem DATABASE_URL_AGENT estão setados — "
                "ai-service não consegue conectar no Postgres"
            )
        _pool = pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=10,
            dsn=dsn,
            cursor_factory=psycopg2.extras.RealDictCursor,
        )
    return _pool


class get_connection:
    """Context manager para pegar/devolver conexão do pool automaticamente."""

    def __enter__(self):
        self.conn = get_pool().getconn()
        self.conn.autocommit = False
        return self.conn

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type:
            self.conn.rollback()
        else:
            self.conn.commit()
        get_pool().putconn(self.conn)
        return False
