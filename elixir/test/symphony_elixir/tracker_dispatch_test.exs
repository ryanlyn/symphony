defmodule SymphonyElixir.Tracker.DispatchTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Config.Schema, as: ConfigSchema
  alias SymphonyElixir.Tracker.Dispatch

  describe "route_names/2" do
    test "parses route labels case-insensitively and normalizes route names" do
      issue = %Issue{labels: ["Symphony:a", "symphony:B", "Symphony: A ", "backend"]}

      assert Dispatch.route_names(issue, "Symphony:") == ["a", "b"]
      assert Dispatch.has_route_label?(issue, "Symphony:")
    end

    test "blank route suffix is routed-invalid and not unrouted" do
      issue = %Issue{labels: ["Symphony:", "backend"]}

      assert Dispatch.route_names(issue, "Symphony:") == []
      assert Dispatch.has_route_label?(issue, "Symphony:")
    end

    test "ordinary labels do not count as routes with the default prefix" do
      issue = %Issue{labels: ["backend", "ensemble:3"]}

      assert Dispatch.route_names(issue, "Symphony:") == []
      refute Dispatch.has_route_label?(issue, "Symphony:")
    end

    test "empty prefix treats every nonblank label as a route" do
      issue = %Issue{labels: ["backend", " ensemble:3 ", "", "BACKEND"]}

      assert Dispatch.route_names(issue, "") == ["backend", "ensemble:3"]
      assert Dispatch.has_route_label?(issue, "")
    end

    test "route helpers tolerate malformed issues and labels" do
      issue = %Issue{labels: [nil, "Symphony:a"]}

      assert Dispatch.route_names(issue, "Symphony:") == ["a"]
      assert Dispatch.has_route_label?(issue, "Symphony:")

      assert Dispatch.route_names(%{labels: ["Symphony:a"]}, "Symphony:") == []
      refute Dispatch.has_route_label?(%{labels: ["Symphony:a"]}, "Symphony:")

      assert Dispatch.normalize_route_name(nil) == ""
    end

    test "nil route label prefix falls back to the default prefix" do
      issue = %Issue{labels: ["Symphony:a", "backend"]}

      assert Dispatch.route_names(issue, nil) == ["a"]
      assert Dispatch.has_route_label?(issue, nil)
    end
  end

  describe "eligible?/2" do
    test "default dispatch settings accept unrouted, ordinary-labeled, and routed issues" do
      dispatch = Config.settings!().tracker.dispatch

      assert Dispatch.eligible?(%Issue{labels: []}, dispatch)
      assert Dispatch.eligible?(%Issue{labels: ["backend"]}, dispatch)
      assert Dispatch.eligible?(%Issue{labels: ["Symphony:a"]}, dispatch)
    end

    test "unrouted-only settings reject any routed issue" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_dispatch_accept_unrouted: true,
        tracker_dispatch_only_routes: []
      )

      dispatch = Config.settings!().tracker.dispatch

      assert Dispatch.eligible?(%Issue{labels: []}, dispatch)
      assert Dispatch.eligible?(%Issue{labels: ["backend"]}, dispatch)
      refute Dispatch.eligible?(%Issue{labels: ["Symphony:a"]}, dispatch)
      refute Dispatch.eligible?(%Issue{labels: ["Symphony:"]}, dispatch)
    end

    test "only_routes allowlist requires at least one matching route" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_dispatch_accept_unrouted: false,
        tracker_dispatch_only_routes: [" A ", "a"]
      )

      dispatch = Config.settings!().tracker.dispatch

      refute Dispatch.eligible?(%Issue{labels: []}, dispatch)
      refute Dispatch.eligible?(%Issue{labels: ["backend"]}, dispatch)
      assert Dispatch.eligible?(%Issue{labels: ["Symphony:a"]}, dispatch)
      assert Dispatch.eligible?(%Issue{labels: ["Symphony:b", "Symphony:a"]}, dispatch)
      refute Dispatch.eligible?(%Issue{labels: ["Symphony:b"]}, dispatch)
    end

    test "unrestricted routed settings reject unrouted when accept_unrouted is false" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_dispatch_accept_unrouted: false,
        tracker_dispatch_only_routes: nil
      )

      dispatch = Config.settings!().tracker.dispatch

      refute Dispatch.eligible?(%Issue{labels: []}, dispatch)
      assert Dispatch.eligible?(%Issue{labels: ["Symphony:a"]}, dispatch)
      refute Dispatch.eligible?(%Issue{labels: ["Symphony:"]}, dispatch)
    end

    test "fallback settings accept all valid routes and unrouted issues" do
      assert Dispatch.eligible?(%Issue{labels: []}, %{})
      assert Dispatch.eligible?(%Issue{labels: ["Symphony:a"]}, %{})
    end

    test "malformed issues are never eligible" do
      refute Dispatch.eligible?(%{labels: ["Symphony:a"]}, %{})
    end
  end

  describe "dispatch config changeset" do
    test "explicit nil only_routes replaces a prior allowlist" do
      changeset =
        ConfigSchema.Dispatch.changeset(
          %ConfigSchema.Dispatch{only_routes: ["old"]},
          %{"only_routes" => nil}
        )

      assert changeset.valid?
      assert Ecto.Changeset.apply_changes(changeset).only_routes == nil
    end
  end
end
