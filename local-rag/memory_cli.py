"""Quick terminal test for episodic/semantic memory and conflict
detection (memory.py), mirroring project_state_cli.py's and
gis/gis_cli.py's role for their own pieces.

    python3 memory_cli.py log-event 1 decision "Ruled out a rear extension" --detail "Article 4 direction removes PD rights for rear extensions"
    python3 memory_cli.py log-event 1 note "Neighbour raised no objection informally"
    python3 memory_cli.py events 1
    python3 memory_cli.py conflicts 1
    python3 memory_cli.py conflicts --all
    python3 memory_cli.py resolve-conflict 3 dismissed
    python3 memory_cli.py distill westminster
    python3 memory_cli.py knowledge westminster
"""

import argparse
import sys

import memory as mem


def _print_event(event):
    print(f"[{event['id']}] ({event['event_type']}, {event['source']}) {event['summary']}")
    if event.get("detail"):
        print(f"  {event['detail']}")
    print(f"  {event['created_at']}")
    for conflict in event.get("conflicts", []):
        print(f"  CONFLICT [{conflict['id']}]: {conflict['explanation']}")
        print(f"    vs. {conflict['conflicting_with']}")


def _print_conflict(conflict):
    print(f"[{conflict['id']}] ({conflict['status']}) project {conflict['site_id']}")
    print(f"  New event: {conflict['new_event_id']}")
    print(f"  Conflicts with: {conflict['conflicting_with']}")
    print(f"  {conflict['explanation']}")
    print(f"  Detected: {conflict['detected_at']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_log = sub.add_parser("log-event")
    p_log.add_argument("project_id", type=int)
    p_log.add_argument("event_type", choices=sorted(mem.VALID_EVENT_TYPES))
    p_log.add_argument("summary")
    p_log.add_argument("--detail")

    p_events = sub.add_parser("events")
    p_events.add_argument("project_id", type=int)
    p_events.add_argument("--type", choices=sorted(mem.VALID_EVENT_TYPES))
    p_events.add_argument("--limit", type=int)

    p_conflicts = sub.add_parser("conflicts")
    p_conflicts.add_argument("project_id", type=int, nargs="?")
    p_conflicts.add_argument("--all", action="store_true", help="ignore project_id, list every project's conflicts")
    p_conflicts.add_argument("--status", choices=sorted(mem.VALID_CONFLICT_STATUSES))

    p_resolve = sub.add_parser("resolve-conflict")
    p_resolve.add_argument("conflict_id", type=int)
    p_resolve.add_argument("status", choices=sorted(mem.VALID_CONFLICT_STATUSES))

    p_distill = sub.add_parser("distill")
    p_distill.add_argument("geography")

    p_knowledge = sub.add_parser("knowledge")
    p_knowledge.add_argument("geography")

    args = parser.parse_args()

    if args.command == "log-event":
        try:
            event = mem.log_event(args.project_id, args.event_type, args.summary, detail=args.detail)
        except ValueError as e:
            print(str(e))
            sys.exit(1)
        if event is None:
            print(f"No project with id {args.project_id}.")
            sys.exit(1)
        _print_event(event)

    elif args.command == "events":
        events = mem.list_events(args.project_id, limit=args.limit, event_type=args.type)
        if not events:
            print("No events yet.")
        for event in events:
            _print_event(event)

    elif args.command == "conflicts":
        project_id = None if args.all else args.project_id
        if not args.all and args.project_id is None:
            print("Give a project_id, or pass --all to list every project's conflicts.")
            sys.exit(1)
        conflicts = mem.list_conflicts(project_id=project_id, status=args.status)
        if not conflicts:
            print("No conflicts.")
        for conflict in conflicts:
            _print_conflict(conflict)

    elif args.command == "resolve-conflict":
        try:
            conflict = mem.resolve_conflict(args.conflict_id, args.status)
        except ValueError as e:
            print(str(e))
            sys.exit(1)
        if conflict is None:
            print(f"No conflict with id {args.conflict_id}.")
            sys.exit(1)
        _print_conflict(conflict)

    elif args.command == "distill":
        facts = mem.distill_lpa_knowledge(args.geography)
        if not facts:
            print(f"No new facts distilled for {args.geography!r} (no decision/note events yet, "
                  f"nothing new and well-supported, or the call failed - check GROQ_API_KEY).")
        for fact in facts:
            print(f"[{fact['id']}] {fact['fact']}")

    elif args.command == "knowledge":
        facts = mem.get_lpa_knowledge(args.geography)
        if not facts:
            print(f"No distilled knowledge for {args.geography!r} yet - run 'distill {args.geography}' first.")
        for fact in facts:
            print(f"[{fact['id']}] {fact['fact']} (from events {fact['source_event_ids']})")


if __name__ == "__main__":
    main()
