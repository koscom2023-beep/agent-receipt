# Open design questions (RFC seeds)

> Deliberately **unanswered.** These decide the long-term semantics, and the honest
> way to answer them is from **real usage**, not invention. Each stays `open` until
> real ledgers exist to settle it. New questions append; answers, when they come,
> get their own note. This is the project's design-memory — not a backlog.

Format: `NNN` · question · why it matters · **Status**.

---

**001 — Should an approval be immutable once recorded?**
If a human approves a receipt and later regrets it, is the approval frozen (and
superseded by a new record) or revocable? Decides whether the audit trail can be
walked back. **Status: open.**

**002 — Can two agents own one receipt?**
When Claude and Cursor both touch a change before one commit, is that one receipt
with two subjects, or two receipts? Decides the Session↔Receipt cardinality.
**Status: open.**

**003 — How is a rollback represented?**
A revert is a new commit → a new ledger line. Is the "this undoes that" link left
implicit in git history, or made an explicit (frozen) relation? Decides whether we
ever need typed edges. **Status: open** (leaning: implicit via git).

**004 — Can receipts merge?**
If several small receipts describe one logical task, is there a "roll-up" receipt,
or do they stay atomic? Decides whether an aggregate object is ever justified.
**Status: open** (leaning: stay atomic).

**005 — Can evidence be partial?**
Capture can miss actions (hooks off, sub-agents). Is a receipt with known-incomplete
evidence a first-class state, or just a caveat? Decides how honesty about gaps is
modeled. **Status: open** (today: caveat + `capture-degraded` marker).

**006 — Same file, two agents, one session — one ledger line or two?**
Cardinality again, at the ledger level. **Status: open.**

**007 — Should a read-only session produce a ledger line at all?**
Today `close-recon` can, with zero changes. Is "the AI looked but changed nothing"
worth a posting? **Status: open.**

**008 — What is the minimal verdict a ledger line must carry to be self-explanatory
on `grep`, without leaking the diff?**
The boundary between "useful summary" and "the ledger becomes the evidence store."
`reconUnexplained` was one step; where does it stop? **Status: open.**

---

*Answering these by guessing would be the worst design debt. They are here to be
lived with until use decides them.*
