import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import z from "zod"
import { Database, eq, asc, sql } from "../storage/db"
import { SessionTable, TodoTable } from "./session.sql"

export namespace Todo {
  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
      priority: z.string().describe("Priority level of the task: high, medium, low"),
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: SessionID.zod,
        todos: z.array(Info),
      }),
    ),
  }

  export function update(input: { sessionID: SessionID; todos: Info[] }) {
    Database.transaction((db) => {
      db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
      if (input.todos.length > 0) {
        db.insert(TodoTable)
          .values(
            input.todos.map((todo, position) => ({
              session_id: input.sessionID,
              content: todo.content,
              status: todo.status,
              priority: todo.priority,
              position,
            })),
          )
          .run()
      }
      db.update(SessionTable)
        .set({
          todo_revision: sql<number>`coalesce(${SessionTable.todo_revision}, 0) + 1`,
          time_updated: sql<number>`case when ${SessionTable.time_updated} >= ${Date.now()} then ${SessionTable.time_updated} + 1 else ${Date.now()} end`,
        })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
    })
    Bus.publish(Event.Updated, input)
  }

  export function get(sessionID: SessionID) {
    const rows = Database.use((db) =>
      db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
    )
    return rows.map((row) => ({
      content: row.content,
      status: row.status,
      priority: row.priority,
    }))
  }
}
