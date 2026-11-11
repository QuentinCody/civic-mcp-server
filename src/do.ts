import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import { CIVIC_CONFIG } from "@bio-mcp/shared/staging/domain-config";
import { boundQuery } from "./utils/bound-query.js";

export class JsonToSqlDO extends RestStagingDO {
	async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname === "/query-bound" && request.method === "POST") {
			return boundQuery(await request.json(), (sql, ...bindings) => this.sql.exec(sql, ...bindings));
		}
		return super.fetch(request);
	}

	protected useConsolidatedEngine() {
		return true;
	}
	protected getDomainConfig() {
		return CIVIC_CONFIG;
	}
}
