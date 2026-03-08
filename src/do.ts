import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import { CIVIC_CONFIG } from "@bio-mcp/shared/staging/domain-config";

export class JsonToSqlDO extends RestStagingDO {
	protected useConsolidatedEngine() {
		return true;
	}
	protected getDomainConfig() {
		return CIVIC_CONFIG;
	}
}
