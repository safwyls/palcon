package palsave

import (
	"context"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func havePython(t *testing.T, module string) bool {
	t.Helper()
	return exec.Command("python3", "-c", "import "+module).Run() == nil
}

// assertFixture checks the extraction of the shared two-player fixture. Both
// save containers hold identical data, so both must produce identical output.
func assertFixture(t *testing.T, result *Result) {
	t.Helper()

	if len(result.Players) != 2 {
		t.Fatalf("want 2 players, got %d", len(result.Players))
	}
	kyoshi := result.Players[0]
	if kyoshi.Nickname != "Kyoshi" || kyoshi.Level != 42 {
		t.Fatalf("unexpected first player: %+v", kyoshi)
	}
	if len(kyoshi.Party) != 2 || len(kyoshi.Palbox) != 2 || len(kyoshi.Base) != 1 {
		t.Fatalf("kyoshi buckets wrong: party=%d palbox=%d base=%d",
			len(kyoshi.Party), len(kyoshi.Palbox), len(kyoshi.Base))
	}
	boss := kyoshi.Party[1]
	if boss.CharacterID != "BOSS_Anubis" || !boss.IsBoss || boss.TalentHP != 100 {
		t.Fatalf("unexpected boss pal: %+v", boss)
	}
	if !kyoshi.Palbox[1].IsLucky {
		t.Fatalf("Kitsunebi should be lucky: %+v", kyoshi.Palbox[1])
	}

	ren := result.Players[1]
	if ren.Nickname != "Ren" || len(ren.Party) != 1 || len(ren.Palbox) != 1 || len(ren.Base) != 0 {
		t.Fatalf("unexpected ren: %+v", ren)
	}
}

// Freshness, single-flight parsing, stale-serving and the settle window are
// internal/savecache's behaviour and are tested there. What's left here is
// what's actually Palworld's: the extractor and the schema it produces.

// assertInventory checks the item containers the newlayout fixture carries.
// Slot data is packed into each slot's RawData, and gear/egg state lives in a
// separate section joined by a dynamic-item guid, so a silent misread here
// would surface as plausible-looking wrong numbers rather than an error.
// assertWorldStorage covers the container→place join: contents come from
// ItemContainerSaveData, but where a container stands only comes from the map
// object that owns it, and the two are joined by container guid.
func assertWorldStorage(t *testing.T, result *Result) {
	t.Helper()

	// Of the fixture's containers, the player bags belong to the inventory
	// view; what's left is the placed chest, the 54-slot orphan and the guild
	// chest. The single-slot one is ground litter and is dropped.
	if len(result.Storage) != 3 {
		t.Fatalf("want 3 storage containers, got %d: %+v", len(result.Storage), result.Storage)
	}

	var guild *StorageContainer
	for i := range result.Storage {
		if result.Storage[i].Kind == KindGuild {
			guild = &result.Storage[i]
		}
	}
	// The guild chest is joined to its contents only by the container's own
	// BelongInfo.GroupId: its GuildChest map objects carry a GuildSecurity
	// module and never name a container, so nothing else points at it. A
	// regression here doesn't error — it silently files the guild's shared
	// stock under "unplaced", which reads as a bug in the save rather than
	// in the parse.
	if guild == nil {
		t.Fatalf("no guild chest in storage: %+v", result.Storage)
	}
	if guild.ObjectID != "GuildChest" {
		t.Fatalf("guild chest objectId = %q, want GuildChest so it gets the game's own name and icon", guild.ObjectID)
	}
	if guild.GuildID != "ffffffff-0000-0000-0000-000000000001" {
		t.Fatalf("guild chest GuildID = %q, want the fixture guild id", guild.GuildID)
	}
	// Shared across the guild rather than standing anywhere, so it reports no
	// position at all — a zero coordinate would put it off the map's corner.
	if guild.X != nil || guild.Y != nil || guild.BaseID != "" {
		t.Fatalf("guild chest should carry no position: %+v", guild)
	}
	if len(guild.Slots) != 1 || guild.Slots[0].ItemID != "Tomato" || guild.Slots[0].Count != 9999 {
		t.Fatalf("guild chest slots wrong: %+v", guild.Slots)
	}

	chest := result.Storage[0]
	if chest.Kind != KindBase || chest.ObjectID != "ItemChest_03" || chest.Size != 30 {
		t.Fatalf("unexpected chest: %+v", chest)
	}
	// Base camp, guild and position all come out of the Model blob, which the
	// reader walks into and stops partway through.
	if chest.BaseID != "eeeeeeee-0000-0000-0000-000000000001" {
		t.Fatalf("chest BaseID = %q, want the fixture camp id", chest.BaseID)
	}
	if chest.GuildID != "ffffffff-0000-0000-0000-000000000001" {
		t.Fatalf("chest GuildID = %q, want the fixture guild id", chest.GuildID)
	}
	if chest.X == nil || chest.Y == nil || *chest.X != 123400.0 || *chest.Y != -56700.0 {
		t.Fatalf("chest position wrong: %+v", chest)
	}
	// Gear sitting in a chest carries the same per-instance state it would in
	// a player's hands — the dynamic-item join isn't inventory-only.
	if len(chest.Slots) != 2 || chest.Slots[1].ItemID != "Katana_2" || chest.Slots[1].Durability != 688 {
		t.Fatalf("chest slots wrong: %+v", chest.Slots)
	}
	if len(chest.Slots[1].Passives) != 1 || chest.Slots[1].Passives[0] != "Legend" {
		t.Fatalf("chest katana passives wrong: %+v", chest.Slots[1])
	}

	orphan := result.Storage[1]
	if orphan.Kind != KindUnplaced || orphan.Size != 54 {
		t.Fatalf("unexpected orphan container: %+v", orphan)
	}
	// Nothing claims it, so it has no place to report — and reporting a
	// zero coordinate would put it in the sea off the map's corner.
	if orphan.X != nil || orphan.Y != nil || orphan.BaseID != "" {
		t.Fatalf("unplaced container should carry no position: %+v", orphan)
	}
	if len(orphan.Slots) != 1 || orphan.Slots[0].ItemID != "Berries" || orphan.Slots[0].Count != 5441 {
		t.Fatalf("orphan slots wrong: %+v", orphan.Slots)
	}

	// A player's bags stay out: they're the inventory payload, and serving the
	// same slots twice would double the largest thing the parse produces.
	for _, c := range result.Storage {
		for _, s := range c.Slots {
			if s.ItemID == "PalSphere_Mega" {
				t.Fatalf("player bag leaked into storage: %+v", c)
			}
		}
	}
}

// assertRecords covers the completion records the achievements view reads.
// The distinctions asserted here are the ones a naive read gets wrong: a false
// flag is "fought and lost" rather than cleared, a zero count is "never" rather
// than tracked, the tower count map is keyed by difficulty while the flag map
// isn't, and one field-boss map holds both named human bounty targets and
// opaque region spawner ids.
func assertRecords(t *testing.T, kyoshi, ren PlayerPals) {
	t.Helper()
	r := kyoshi.Records
	// Four flagged true across all three kinds the map mixes — two region
	// towers, a World Tree gate boss and Panthalus. The extractor hands the
	// whole map over and lets the view sort them out.
	if len(r.Towers) != 4 {
		t.Fatalf("kyoshi towers = %v, want the 4 flagged true", r.Towers)
	}
	// Same tower, two difficulties, two rows — the view has to sum them.
	if r.TowerCounts["GrassBoss_Normal"] != 2 || r.TowerCounts["GrassBoss_Hard"] != 1 {
		t.Fatalf("kyoshi tower counts = %v", r.TowerCounts)
	}
	if len(r.Raids) != 1 || r.Raids["PalSummon_NightLady"] != 3 {
		t.Fatalf("kyoshi raids = %v, want only the non-zero one", r.Raids)
	}
	if len(r.FieldBosses) != 4 {
		t.Fatalf("kyoshi field bosses = %v, want the 4 flagged true", r.FieldBosses)
	}
	if len(r.NpcRewards) != 2 {
		t.Fatalf("kyoshi npc rewards = %v", r.NpcRewards)
	}
	// The whole completed array, main and side and hidden — the split into
	// main-line quests is the view's job, not the extractor's.
	if len(r.Quests) != 4 {
		t.Fatalf("kyoshi quests = %v, want all 4 completed", r.Quests)
	}
	// Relics sums the per-kind map (2 + 1), not the legacy Lifmunk-only flag,
	// which the fixture deliberately leaves disagreeing at 1.
	if r.FastTravel != 2 || r.Areas != 1 || r.Relics != 3 || r.Notes != 1 {
		t.Fatalf("kyoshi exploration counts wrong: %+v", r)
	}
	if len(r.EffigyTypes) != 2 || r.EffigyTypes["CapturePower"] != 2 || r.EffigyTypes["JumpPower"] != 1 {
		t.Fatalf("kyoshi effigy kinds = %v", r.EffigyTypes)
	}
	if r.CampsConquered != 3 || r.DungeonsCleared != 7 || r.FixedDungeonsCleared != 2 {
		t.Fatalf("kyoshi clear counts wrong: %+v", r)
	}
	if r.TreasuresFound != 1 || r.TribesCaptured != 41 || r.Mutations != 5 || r.BossTechPoints != 12 {
		t.Fatalf("kyoshi misc counts wrong: %+v", r)
	}
	if r.PredatorsDefeated != 6 || r.OilrigsCleared != 4 || r.Awakenings != 2 || !r.GameCleared {
		t.Fatalf("kyoshi late-game counts wrong: %+v", r)
	}
	// The arena rungs are handed over as they come; "highest cleared" is a
	// ladder order the view owns, and Gold beats Silver despite sorting after
	// it in neither alphabetical nor insertion order.
	if len(r.ArenaRanks) != 3 || r.ArenaRanks["Silver"] != 2 || r.ArenaRanks["Gold"] != 1 {
		t.Fatalf("kyoshi arena ranks = %v", r.ArenaRanks)
	}
	// The EPalRelicType:: prefix is stripped and the zero rank dropped.
	if len(r.RelicRanks) != 2 || r.RelicRanks["CapturePower"] != 7 || r.RelicRanks["MoveSpeed"] != 3 {
		t.Fatalf("kyoshi relic ranks = %v", r.RelicRanks)
	}
	if ren.Records.GameCleared || len(ren.Records.ArenaRanks) != 0 {
		t.Fatalf("ren should have no late-game record: %+v", ren.Records)
	}
	// Ren's save has no RecordData and no quest array at all, which must read
	// as an empty record rather than failing the parse.
	if len(ren.Records.Towers) != 0 || len(ren.Records.Raids) != 0 || len(ren.Records.Quests) != 0 {
		t.Fatalf("ren records should be empty: %+v", ren.Records)
	}
}

func assertInventory(t *testing.T, kyoshi, ren PlayerPals) {
	t.Helper()

	bag, ok := kyoshi.Inventory["common"]
	if !ok {
		t.Fatalf("kyoshi has no backpack: %+v", kyoshi.Inventory)
	}
	if bag.Size != 6 {
		t.Fatalf("backpack size = %d, want 6", bag.Size)
	}
	// Three occupied slots out of five written: the zero-count one is empty
	// and dropped, and slot 2 was never written at all. Slot numbers are the
	// point — the viewer draws the bag by them.
	want := []ItemSlot{
		{Slot: 0, ItemID: "Money", Count: 1200},
		{Slot: 1, ItemID: "PalSphere_Mega", Count: 42},
		{Slot: 4, ItemID: "PalEgg_Fire_01", Count: 1, EggSpecies: "Kitsunebi"},
	}
	if !reflect.DeepEqual(bag.Slots, want) {
		t.Fatalf("kyoshi backpack = %+v, want %+v", bag.Slots, want)
	}

	// Gear state comes from DynamicItemSaveData, keyed by the guid on the slot.
	arms := kyoshi.Inventory["weapons"]
	if len(arms.Slots) != 1 || arms.Slots[0].Durability != 2857 || arms.Slots[0].Ammo != 1 {
		t.Fatalf("kyoshi weapons = %+v, want one bow at 2857 durability with 1 round", arms.Slots)
	}
	if keys := kyoshi.Inventory["essential"]; keys.Size != 230 || len(keys.Slots) != 1 {
		t.Fatalf("kyoshi key items = %+v, want 1 of 230 slots", keys)
	}

	// A weapon that rolled its own passive, on a player whose save declares
	// only a backpack — the other container fields are absent entirely.
	sword := ren.Inventory["common"]
	if len(sword.Slots) != 1 || !reflect.DeepEqual(sword.Slots[0].Passives, []string{"Legend"}) {
		t.Fatalf("ren backpack = %+v, want one katana with a Legend passive", sword.Slots)
	}
	for _, role := range []string{"essential", "weapons", "equipment"} {
		if _, ok := ren.Inventory[role]; ok {
			t.Fatalf("ren should have no %q container: %+v", role, ren.Inventory)
		}
	}

	assertCharacter(t, kyoshi, ren)

	// The fixture's world chest belongs to nobody and must not be attributed.
	for _, p := range []PlayerPals{kyoshi, ren} {
		for role, c := range p.Inventory {
			for _, s := range c.Slots {
				if s.ItemID == "Wood" {
					t.Fatalf("%s picked up the unowned chest's contents in %q", p.Nickname, role)
				}
			}
		}
	}
}

// assertCharacter checks the player's own save entry: level progress,
// condition and stat-point spend. The point lists arrive with Japanese stat
// names whatever language the server runs in, so a missed mapping would show
// up as an untranslated label rather than an error.
func assertCharacter(t *testing.T, kyoshi, ren PlayerPals) {
	t.Helper()

	c := kyoshi.Character
	if c == nil {
		t.Fatal("kyoshi has no character record")
	}
	// Hp and ShieldHP are FixedPoint64 — stored ×1000.
	if c.Exp != 1234567 || c.HP != 6820 || c.Shield != 1045 || c.Stomach != 89.5 {
		t.Fatalf("kyoshi condition = %+v, want exp 1234567, hp 6820, shield 1045, stomach 89.5", c)
	}
	if c.UnusedStatusPoints != 2 {
		t.Fatalf("kyoshi unused points = %d, want 2", c.UnusedStatusPoints)
	}
	// Stats the player put nothing into are dropped, so a build reads as what
	// was actually invested rather than a list padded with zeroes.
	wantPoints := map[string]int{
		"Max HP": 17, "Max SP": 18, "Attack": 18, "Carry Weight": 18,
		"Capture Rate": 7, "Movement Speed": 15, "Stamina Cost Reduction": 20,
	}
	if !reflect.DeepEqual(c.StatusPoints, wantPoints) {
		t.Fatalf("kyoshi status points = %v, want %v", c.StatusPoints, wantPoints)
	}
	if !reflect.DeepEqual(c.ExStatusPoints, map[string]int{"Max HP": 9, "Attack": 7}) {
		t.Fatalf("kyoshi ex status points = %v", c.ExStatusPoints)
	}
	if c.FoodBuff != "Minestrone" || c.FoodBuffSeconds != 367 {
		t.Fatalf("kyoshi food buff = %q/%ds, want Minestrone/367s", c.FoodBuff, c.FoodBuffSeconds)
	}

	// Ren's entry carries none of it — a player who has never spent a point
	// must read as an empty build, not a missing record.
	if ren.Character == nil {
		t.Fatal("ren should still have a character record")
	}
	if len(ren.Character.StatusPoints) != 0 || ren.Character.Exp != 0 || ren.Character.FoodBuff != "" {
		t.Fatalf("ren character should be empty: %+v", ren.Character)
	}
}

// The fixtures are synthetic — see testdata/README.md — so they exercise the
// real decompress/GVAS-parse/extract path with no copyrighted game data.
func TestRead(t *testing.T) {
	if !havePython(t, "palworld_save_tools") {
		t.Skip("python3 with palworld-save-tools not available")
	}

	tests := []struct {
		name string
		// path is relative to this package; a directory must resolve to the
		// Level.sav inside it, a file must be read directly. Empty means the
		// fixture is generated into a temp dir by gen_newlayout_fixture.py —
		// it needs only palworld_save_tools, which this test already
		// requires, and generating keeps the storage sidecars covered
		// without committing more .sav binaries.
		path       string
		needsOodle bool
		// The newlayout fixture also carries pal-storage files: a
		// Players/<uid>_dps.sav for Kyoshi (two pals plus an empty slot)
		// and a GlobalPalStorage.sav pal old-owned by Ren.
		hasStorage bool
	}{
		{name: "PlZ/zlib via directory", path: "testdata"},
		{name: "PlM/oodle via file", path: "testdata/Level_oodle.sav", needsOodle: true},
		// 0.6-era layout: pals carry no OwnerPlayerUId and players keep their
		// container ids in Players/<uid>.sav, so ownership resolves by
		// container. Produced zero pals for every player before that was
		// handled — hence a fixture rather than trusting the old one.
		{name: "container-based ownership", hasStorage: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.needsOodle && !havePython(t, "ooz") {
				t.Skip("python3 with pyooz not available")
			}
			reader, err := NewReader(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			fixture := tc.path
			if fixture == "" {
				dir := t.TempDir()
				gen := exec.Command("python3", "gen_newlayout_fixture.py", dir)
				gen.Dir = "testdata"
				if out, err := gen.CombinedOutput(); err != nil {
					t.Fatalf("generating newlayout fixture: %v: %s", err, out)
				}
				fixture = dir
			}
			path, err := filepath.Abs(fixture)
			if err != nil {
				t.Fatal(err)
			}
			result, err := reader.Read(context.Background(), path)
			if err != nil {
				t.Fatal(err)
			}
			assertFixture(t, result)

			kyoshi, ren := result.Players[0], result.Players[1]
			if tc.hasStorage {
				if len(kyoshi.Storage) != 2 || kyoshi.Storage[0].CharacterID != "Bastet" || kyoshi.Storage[1].TalentShot != 100 {
					t.Fatalf("kyoshi storage wrong: %+v", kyoshi.Storage)
				}
				if len(ren.Storage) != 1 || ren.Storage[0].CharacterID != "Umihebi" {
					t.Fatalf("ren storage wrong: %+v", ren.Storage)
				}
				// A storage pal's slot is its position in the sidecar's array,
				// not its own SlotId (stale in storage) — so the empty slot 1
				// between the fixture's two pals leaves JetDragon at 2, which
				// is what the UI turns into "page 1, slot 3".
				if kyoshi.Storage[0].SlotIndex != 0 || kyoshi.Storage[1].SlotIndex != 2 {
					t.Fatalf("kyoshi storage slots = %d, %d; want 0, 2",
						kyoshi.Storage[0].SlotIndex, kyoshi.Storage[1].SlotIndex)
				}
				if ren.Storage[0].SlotIndex != 0 {
					t.Fatalf("ren storage slot = %d, want 0", ren.Storage[0].SlotIndex)
				}
				// Paldex records ride in Players/<uid>.sav: three registered
				// species (Penguin's flag is false — seen, not registered),
				// and capture counts. Ren's save has no RecordData at all,
				// which must yield empty, not missing, fields.
				if len(kyoshi.Paldeck) != 3 || kyoshi.Captures["SheepBall"] != 4 || len(kyoshi.Captures) != 2 {
					t.Fatalf("kyoshi paldex wrong: deck=%v captures=%v", kyoshi.Paldeck, kyoshi.Captures)
				}
				if len(ren.Paldeck) != 0 || len(ren.Captures) != 0 {
					t.Fatalf("ren paldex should be empty: deck=%v captures=%v", ren.Paldeck, ren.Captures)
				}
				assertRecords(t, kyoshi, ren)
				// The base pal ties to its camp via the WorkerDirector's
				// container id; party/palbox pals carry no base.
				if kyoshi.Base[0].BaseID != "eeeeeeee-0000-0000-0000-000000000001" {
					t.Fatalf("base pal BaseID = %q, want the fixture camp id", kyoshi.Base[0].BaseID)
				}
				if kyoshi.Party[0].BaseID != "" {
					t.Fatalf("party pal BaseID = %q, want empty", kyoshi.Party[0].BaseID)
				}
				assertInventory(t, kyoshi, ren)
				assertWorldStorage(t, result)
			} else if len(kyoshi.Storage) != 0 || len(ren.Storage) != 0 {
				t.Fatalf("unexpected storage pals: %+v %+v", kyoshi.Storage, ren.Storage)
			}

			// A second read of an unchanged file must come from cache —
			// verified by pointer identity, since a re-parse would allocate.
			again, err := reader.Read(context.Background(), path)
			if err != nil {
				t.Fatal(err)
			}
			if again != result {
				t.Fatal("expected cached result on unchanged mtime")
			}
		})
	}
}
