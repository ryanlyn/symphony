defmodule SymphonyElixir.ToolsTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Tools

  describe "execute/3" do
    test "passes read queries through to the configured client" do
      test_pid = self()
      expected_response = %{"data" => %{"issues" => %{"nodes" => []}}}

      result =
        Tools.execute(
          "linear_graphql",
          %{"query" => "query { issues { nodes { id } } }"},
          linear_client: fn query, variables, _opts ->
            send(test_pid, {:linear_called, query, variables})
            {:ok, expected_response}
          end
        )

      assert result == {:ok, %{success: true, payload: expected_response}}
      assert_received {:linear_called, "query { issues { nodes { id } } }", %{}}
    end

    test "marks GraphQL error responses as unsuccessful while preserving the body" do
      expected_response = %{"errors" => [%{"message" => "boom"}], "data" => nil}

      assert {:ok, %{success: false, payload: ^expected_response}} =
               Tools.execute(
                 "linear_graphql",
                 %{"query" => "query { viewer { id } }"},
                 linear_client: fn _query, _variables, _opts -> {:ok, expected_response} end
               )
    end

    test "propagates client failures as tool payloads" do
      assert {:error, payload} =
               Tools.execute(
                 "linear_graphql",
                 %{"query" => "query { viewer { id } }"},
                 linear_client: fn _query, _variables, _opts -> {:error, :timeout} end
               )

      assert payload["error"]["message"] == "Linear GraphQL tool execution failed."
      assert payload["error"]["reason"] == ":timeout"
    end

    test "accepts a raw string argument and passes it as the query with empty variables" do
      test_pid = self()
      expected_response = %{"data" => %{"viewer" => %{"id" => "user-1"}}}

      result =
        Tools.execute(
          "linear_graphql",
          "query { viewer { id } }",
          linear_client: fn query, variables, _opts ->
            send(test_pid, {:linear_called, query, variables})
            {:ok, expected_response}
          end
        )

      assert result == {:ok, %{success: true, payload: expected_response}}
      assert_received {:linear_called, "query { viewer { id } }", %{}}
    end

    test "returns missing_query error for an empty string argument" do
      assert {:error, payload} =
               Tools.execute(
                 "linear_graphql",
                 "",
                 linear_client: fn _q, _v, _o -> {:ok, %{}} end
               )

      assert payload["error"]["message"] ==
               "`linear_graphql` requires a non-empty `query` string."
    end

    test "returns missing_query error for a whitespace-only string argument" do
      assert {:error, payload} =
               Tools.execute(
                 "linear_graphql",
                 "   \n\t  ",
                 linear_client: fn _q, _v, _o -> {:ok, %{}} end
               )

      assert payload["error"]["message"] ==
               "`linear_graphql` requires a non-empty `query` string."
    end

    test "returns missing_query error when map argument has an empty query string" do
      assert {:error, payload} =
               Tools.execute(
                 "linear_graphql",
                 %{"query" => ""},
                 linear_client: fn _q, _v, _o -> {:ok, %{}} end
               )

      assert payload["error"]["message"] ==
               "`linear_graphql` requires a non-empty `query` string."
    end

    test "returns missing_query error when map argument has no query key" do
      assert {:error, payload} =
               Tools.execute(
                 "linear_graphql",
                 %{"variables" => %{"id" => "1"}},
                 linear_client: fn _q, _v, _o -> {:ok, %{}} end
               )

      assert payload["error"]["message"] ==
               "`linear_graphql` requires a non-empty `query` string."
    end

    test "returns invalid_arguments error for non-string, non-map argument types" do
      assert {:error, payload} =
               Tools.execute(
                 "linear_graphql",
                 42,
                 linear_client: fn _q, _v, _o -> {:ok, %{}} end
               )

      assert payload["error"]["message"] ==
               "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`."
    end

    test "returns invalid_arguments error for a list argument" do
      assert {:error, payload} =
               Tools.execute(
                 "linear_graphql",
                 ["query { viewer { id } }"],
                 linear_client: fn _q, _v, _o -> {:ok, %{}} end
               )

      assert payload["error"]["message"] ==
               "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`."
    end

    test "returns invalid_variables error when variables is not a map" do
      assert {:error, payload} =
               Tools.execute(
                 "linear_graphql",
                 %{"query" => "query { viewer { id } }", "variables" => "not_a_map"},
                 linear_client: fn _q, _v, _o -> {:ok, %{}} end
               )

      assert payload["error"]["message"] ==
               "`linear_graphql.variables` must be a JSON object when provided."
    end

    test "returns invalid_variables error when variables is a list" do
      assert {:error, payload} =
               Tools.execute(
                 "linear_graphql",
                 %{"query" => "query { viewer { id } }", "variables" => [1, 2, 3]},
                 linear_client: fn _q, _v, _o -> {:ok, %{}} end
               )

      assert payload["error"]["message"] ==
               "`linear_graphql.variables` must be a JSON object when provided."
    end

    test "passes variables through to the client function when provided as a map" do
      test_pid = self()
      variables = %{"teamId" => "team-1", "first" => 10}

      Tools.execute(
        "linear_graphql",
        %{"query" => "query($teamId: String!) { team(id: $teamId) { name } }", "variables" => variables},
        linear_client: fn _query, vars, _opts ->
          send(test_pid, {:variables_received, vars})
          {:ok, %{"data" => %{"team" => %{"name" => "Engineering"}}}}
        end
      )

      assert_received {:variables_received, ^variables}
    end

    test "defaults variables to an empty map when not provided in map argument" do
      test_pid = self()

      Tools.execute(
        "linear_graphql",
        %{"query" => "query { viewer { id } }"},
        linear_client: fn _query, vars, _opts ->
          send(test_pid, {:variables_received, vars})
          {:ok, %{"data" => %{"viewer" => %{"id" => "u1"}}}}
        end
      )

      assert_received {:variables_received, %{}}
    end

    test "returns unsupported tool error for an unknown tool name" do
      assert {:error, payload} =
               Tools.execute(
                 "unknown_tool",
                 %{"query" => "test"},
                 linear_client: fn _q, _v, _o -> {:ok, %{}} end
               )

      assert payload["error"]["message"] == "Unsupported tool."
      assert payload["error"]["supportedTools"] == ["linear_graphql"]
    end

    test "returns unsupported tool error for a nil tool name" do
      assert {:error, payload} =
               Tools.execute(
                 nil,
                 %{},
                 linear_client: fn _q, _v, _o -> {:ok, %{}} end
               )

      assert payload["error"]["message"] == "Unsupported tool."
      assert is_list(payload["error"]["supportedTools"])
    end

    test "trims whitespace from query in map arguments before passing to client" do
      test_pid = self()

      Tools.execute(
        "linear_graphql",
        %{"query" => "  query { viewer { id } }  \n"},
        linear_client: fn query, _vars, _opts ->
          send(test_pid, {:query_received, query})
          {:ok, %{"data" => %{"viewer" => %{"id" => "u1"}}}}
        end
      )

      assert_received {:query_received, "query { viewer { id } }"}
    end

    test "recognizes atom-keyed query in map arguments" do
      test_pid = self()

      Tools.execute(
        "linear_graphql",
        %{query: "query { viewer { id } }"},
        linear_client: fn query, _vars, _opts ->
          send(test_pid, {:query_received, query})
          {:ok, %{"data" => %{"viewer" => %{"id" => "u1"}}}}
        end
      )

      assert_received {:query_received, "query { viewer { id } }"}
    end

    test "recognizes atom-keyed variables in map arguments" do
      test_pid = self()
      vars = %{"id" => "issue-1"}

      Tools.execute(
        "linear_graphql",
        %{query: "query($id: String!) { issue(id: $id) { title } }", variables: vars},
        linear_client: fn _query, variables, _opts ->
          send(test_pid, {:variables_received, variables})
          {:ok, %{"data" => %{"issue" => %{"title" => "Test"}}}}
        end
      )

      assert_received {:variables_received, ^vars}
    end

    test "marks response with atom-keyed errors list as unsuccessful" do
      response = %{errors: [%{message: "unauthorized"}], data: nil}

      assert {:ok, %{success: false, payload: ^response}} =
               Tools.execute(
                 "linear_graphql",
                 %{"query" => "query { viewer { id } }"},
                 linear_client: fn _q, _v, _o -> {:ok, response} end
               )
    end

    test "marks response with empty errors list as successful" do
      response = %{"errors" => [], "data" => %{"viewer" => %{"id" => "u1"}}}

      assert {:ok, %{success: true, payload: ^response}} =
               Tools.execute(
                 "linear_graphql",
                 %{"query" => "query { viewer { id } }"},
                 linear_client: fn _q, _v, _o -> {:ok, response} end
               )
    end
  end

  describe "tool_specs/0" do
    test "returns a list containing the linear_graphql tool specification" do
      specs = Tools.tool_specs()

      assert is_list(specs)
      assert length(specs) == 1

      [spec] = specs
      assert spec["name"] == "linear_graphql"
      assert is_binary(spec["description"])
      assert spec["inputSchema"]["type"] == "object"
      assert spec["inputSchema"]["required"] == ["query"]
    end
  end

  describe "supported_tool_names/0" do
    test "returns the list of supported tool names" do
      assert Tools.supported_tool_names() == ["linear_graphql"]
    end
  end

  describe "unsupported_tool_payload/0" do
    test "returns a map with error message and supported tool names" do
      payload = Tools.unsupported_tool_payload()

      assert payload["error"]["message"] == "Unsupported tool."
      assert payload["error"]["supportedTools"] == ["linear_graphql"]
    end
  end

  describe "encode_payload/1" do
    test "encodes a map to pretty-printed JSON" do
      result = Tools.encode_payload(%{"key" => "value"})
      assert is_binary(result)
      assert Jason.decode!(result) == %{"key" => "value"}
    end

    test "encodes a list to pretty-printed JSON" do
      result = Tools.encode_payload([1, 2, 3])
      assert is_binary(result)
      assert Jason.decode!(result) == [1, 2, 3]
    end

    test "uses inspect for non-map, non-list values" do
      assert Tools.encode_payload(:some_atom) == ":some_atom"
      assert Tools.encode_payload(42) == "42"
    end
  end
end
