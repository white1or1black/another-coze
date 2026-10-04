/** 生成成功后扣 1 积分;并发安全(条件 UPDATE),返回扣减后的最新余额(未扣减时为 null) */
export async function deductCredit(db: D1Database, userId: string): Promise<number | null> {
  const row = await db
    .prepare('UPDATE users SET credits = credits - 1 WHERE id = ? AND credits > 0 RETURNING credits')
    .bind(userId)
    .first<{ credits: number }>()
  return row?.credits ?? null
}
