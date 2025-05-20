# Using the CIViC Cancer Variants MCP Server with Claude Desktop

## License and Citation

This project is available under the MIT License with an Academic Citation Requirement. This means you can freely use, modify, and distribute the code, but any academic or scientific publication that uses this software must provide appropriate attribution.

### For academic/research use:
If you use this software in a research project that leads to a publication, presentation, or report, you **must** cite this work according to the format provided in [CITATION.md](CITATION.md).

### For commercial/non-academic use:
Commercial and non-academic use follows the standard MIT License terms without the citation requirement.

By using this software, you agree to these terms. See [LICENSE.md](LICENSE.md) for the complete license text.This guide explains how to connect the CIViC (Clinical Interpretation of Variants in Cancer) MCP Server to your Claude Desktop application. This will allow you to ask Claude questions about cancer genes, variants, and related evidence, with Claude retrieving answers directly from the CIViC open-access database.

## What is this?

*   **CIViC Database:** A publicly accessible database that stores information about the clinical relevance of cancer gene mutations. Scientists and researchers contribute to and curate this information.
*   **MCP Server:** A piece of software that acts as a bridge, allowing Claude to "talk" to the CIViC database using a special language (GraphQL). This specific server is named "CivicExplorer".
*   **Claude Desktop:** The application on your computer where you interact with Claude.

By connecting this MCP server, you empower Claude to access and use the specialized knowledge within CIViC to answer your research-related questions.

## Prerequisites

*   You have Claude Desktop installed on your computer.

## Connecting to Claude Desktop

To enable Claude to use the CIViC database, you need to tell Claude Desktop how to find this server. You'll do this by editing a configuration file.

1.  **Open Claude Desktop Settings:**
    *   In Claude Desktop, go to `Settings`.
    *   Navigate to the `Developer` section.
    *   Click on `Edit Config`. This will open a text file (usually named `claude_desktop_config.json`).

2.  **Update the Configuration:**
    You need to add an entry for the CIViC MCP Server. If the file already has a section called `"mcpServers"`, you'll add the CIViC server details there. If not, you might need to add the whole `"mcpServers"` block.

    Copy and paste the following configuration into the `"mcpServers"` section of your `claude_desktop_config.json` file:

    ```json
    {
      "mcpServers": {
        // ... (other servers might already be listed here, add a comma if needed)
        "civic-mcp-server": {
          "command": "npx",
          "args": [
            "mcp-remote",
            "https://civic-mcp-server.quentincody.workers.dev/sse"
          ]
        }
        // ... (if adding at the end of other servers, ensure no trailing comma on the last one)
      }
    }
    ```

    *   **Explanation of the configuration:**
        *   `"civic-mcp-server"`: This is just a friendly name you're giving this connection within Claude Desktop.
        *   `"command": "npx"` and `"args": [...]`: These tell Claude Desktop the technical details of how to communicate with the CIViC server using a helper tool (`mcp-remote`) and the server's web address.

3.  **Save and Restart:**
    *   Save the `claude_desktop_config.json` file.
    *   Restart Claude Desktop completely for the changes to take effect.

## How to Use

Once connected, Claude will automatically try to use the CIViC MCP Server when you ask questions related to cancer genomics, variants, genes, evidence items, or clinical interpretations.

For example, you can ask Claude questions like:

*   "What information does CIViC have on the BRAF V600E mutation?"
*   "Show me evidence items related to gene EGFR in lung cancer."
*   "Are there any clinical assertions for KRAS G12C?"

Claude will use the server (and its `civic_graphql_query` tool) to fetch the relevant data from the CIViC database and present it to you. The server is designed to query version 2 of the CIViC API, ensuring you get up-to-date information.

If you encounter issues or Claude doesn't seem to be using the CIViC data, double-check the configuration steps above.
