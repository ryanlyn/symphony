defmodule SymphonyElixir.Linear.IssueTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Linear.Issue

  describe "ensemble_size/1" do
    test "returns nil when no ensemble label present" do
      issue = %Issue{labels: ["bug", "priority:high"]}
      assert Issue.ensemble_size(issue) == nil
    end

    test "returns nil for empty labels" do
      issue = %Issue{labels: []}
      assert Issue.ensemble_size(issue) == nil
    end

    test "parses ensemble:3 label correctly" do
      issue = %Issue{labels: ["bug", "ensemble:3"]}
      assert Issue.ensemble_size(issue) == 3
    end

    test "parses ensemble:1 label correctly" do
      issue = %Issue{labels: ["ensemble:1"]}
      assert Issue.ensemble_size(issue) == 1
    end

    test "ignores invalid labels (ensemble:0, ensemble:abc)" do
      issue = %Issue{labels: ["ensemble:0"]}
      assert Issue.ensemble_size(issue) == nil

      issue = %Issue{labels: ["ensemble:abc"]}
      assert Issue.ensemble_size(issue) == nil
    end

    test "takes first valid ensemble label when multiple present" do
      issue = %Issue{labels: ["ensemble:5", "ensemble:3"]}
      assert Issue.ensemble_size(issue) == 5
    end
  end
end
