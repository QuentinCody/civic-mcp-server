import {DatabaseSync} from "node:sqlite";
import {expect, it} from "vitest";
import {boundQuery} from "./bound-query";

it("binds quoted SQL-looking text as data and preserves tables", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE evidence (id TEXT)");
    const text = "x'); DROP TABLE evidence; --";
    const response = boundQuery({sql: "SELECT ? AS value", params: [text]}, (sql, ...params) => db.prepare(sql).iterate(...params));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({success: true, results: [{value: text}], row_count: 1});
    expect(db.prepare("SELECT count(*) AS n FROM evidence").get()?.n).toBe(0);
  } finally {db.close();}
});
it.each([
  {sql: "DELETE FROM evidence", params: [], allow_write: true},
  {sql: "SELECT 1; DROP TABLE evidence", params: []},
  {sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT x FROM n", params: []},
  {sql: "SELECT ?", params: [1]},
])("rejects writes, multiple statements, unbounded recursion and invalid bindings: %j", async input => {
  let invoked = false;
  const response = boundQuery(input, () => {invoked = true; return [][Symbol.iterator]();});
  expect(response.status).toBe(400);
  expect((await response.json() as {success: boolean}).success).toBe(false);
  expect(invoked).toBe(false);
});
