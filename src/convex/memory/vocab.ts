// Controlled vocabulary for fault components, per design doc §7.
// Mirrors `vocab/components.yaml` (TS module on this stack — see DECISIONS.md D1).

export type ComponentDef = {
  key: string; // controlled value the LLM must choose from
  label: string; // human label
  synonyms: string[]; // spoken slang for extraction hints + STT vocab
  recurrenceHours?: number; // §9 recurrence window override
  recurrenceDays?: number;
};

export const MACHINE_CLASSES = ["excavator", "dozer"] as const;
export type MachineClass = (typeof MACHINE_CLASSES)[number];

export const COMPONENTS: Record<MachineClass, ComponentDef[]> = {
  excavator: [
    { key: "hydraulic_pump", label: "Main hydraulic pump", synonyms: ["main pump", "pump", "hydraulics", "hydro pump", "pump whine"], recurrenceHours: 100, recurrenceDays: 21 },
    { key: "swing_motor", label: "Swing motor", synonyms: ["swing", "slew motor", "house swing"], recurrenceHours: 100, recurrenceDays: 14 },
    { key: "travel_motor", label: "Travel motor", synonyms: ["travel", "drive motor", "won't track", "tracks slow"], recurrenceHours: 100, recurrenceDays: 14 },
    { key: "boom_cylinder", label: "Boom cylinder", synonyms: ["boom ram", "boom cylinder", "boom drift"], recurrenceHours: 80, recurrenceDays: 14 },
    { key: "stick_cylinder", label: "Stick cylinder", synonyms: ["stick ram", "arm cylinder"], recurrenceHours: 80, recurrenceDays: 14 },
    { key: "bucket_cylinder", label: "Bucket cylinder", synonyms: ["bucket ram"], recurrenceHours: 80, recurrenceDays: 14 },
    { key: "main_control_valve", label: "Main control valve", synonyms: ["control valve", "spool", "valve bank"], recurrenceHours: 100, recurrenceDays: 21 },
    { key: "hydraulic_hose", label: "Hydraulic hose", synonyms: ["hose", "line burst", "hose leak", "weeper"], recurrenceHours: 60, recurrenceDays: 10 },
    { key: "engine_turbo", label: "Engine turbocharger", synonyms: ["turbo", "boost", "whistle", "no power up hills"], recurrenceHours: 120, recurrenceDays: 21 },
    { key: "fuel_injector", label: "Fuel injector", synonyms: ["injector", "injectors", "missing", "smoking", "hard start"], recurrenceHours: 120, recurrenceDays: 30 },
    { key: "engine_water_pump", label: "Engine water pump", synonyms: ["water pump", "coolant pump", "overheating"], recurrenceHours: 120, recurrenceDays: 21 },
    { key: "final_drive", label: "Final drive", synonyms: ["final drive", "planetary", "hub"], recurrenceHours: 150, recurrenceDays: 30 },
    { key: "swing_bearing", label: "Swing bearing", synonyms: ["swing ring", "slew bearing", "slop in house"], recurrenceHours: 200, recurrenceDays: 45 },
    { key: "track_tensioner", label: "Track tensioner", synonyms: ["track tension", "loose track", "track slack", "grease cylinder"], recurrenceHours: 80, recurrenceDays: 14 },
    { key: "cab_hvac", label: "Cab HVAC", synonyms: ["aircon", "ac", "heater", "cab fan"], recurrenceHours: 60, recurrenceDays: 14 },
    { key: "electrical_harness", label: "Electrical harness", synonyms: ["wiring", "harness", "electrical gremlin", "short"], recurrenceHours: 60, recurrenceDays: 14 },
    { key: "undercarriage_roller", label: "Undercarriage roller", synonyms: ["bottom roller", "track roller", "roller"], recurrenceHours: 150, recurrenceDays: 30 },
    { key: "sensor", label: "Sensor", synonyms: ["sensor", "code", "fault light", "alarm"], recurrenceHours: 50, recurrenceDays: 10 },
  ],
  dozer: [
    { key: "hydraulic_pump", label: "Main hydraulic pump", synonyms: ["main pump", "pump", "hydraulics"], recurrenceHours: 100, recurrenceDays: 21 },
    { key: "blade_cylinder", label: "Blade cylinder", synonyms: ["blade ram", "blade drift", "blade won't hold"], recurrenceHours: 80, recurrenceDays: 14 },
    { key: "ripper_valve", label: "Ripper valve", synonyms: ["ripper", "ripper valve"], recurrenceHours: 80, recurrenceDays: 14 },
    { key: "final_drive", label: "Final drive", synonyms: ["final drive", "planetary", "hub"], recurrenceHours: 150, recurrenceDays: 30 },
    { key: "track_tensioner", label: "Track tensioner", synonyms: ["track tension", "loose track", "track slack"], recurrenceHours: 80, recurrenceDays: 14 },
    { key: "engine_turbo", label: "Engine turbocharger", synonyms: ["turbo", "boost", "no power"], recurrenceHours: 120, recurrenceDays: 21 },
    { key: "fuel_injector", label: "Fuel injector", synonyms: ["injector", "injectors", "missing", "smoking"], recurrenceHours: 120, recurrenceDays: 30 },
    { key: "coolant_pump", label: "Coolant pump", synonyms: ["water pump", "overheating", "coolant"], recurrenceHours: 120, recurrenceDays: 21 },
    { key: "electrical_harness", label: "Electrical harness", synonyms: ["wiring", "harness", "short"], recurrenceHours: 60, recurrenceDays: 14 },
    { key: "cab_hvac", label: "Cab HVAC", synonyms: ["aircon", "ac", "heater"], recurrenceHours: 60, recurrenceDays: 14 },
    { key: "undercarriage_roller", label: "Undercarriage roller", synonyms: ["bottom roller", "track roller"], recurrenceHours: 150, recurrenceDays: 30 },
    { key: "sensor", label: "Sensor", synonyms: ["sensor", "code", "fault light"], recurrenceHours: 50, recurrenceDays: 10 },
  ],
};

export const MODELS: Record<MachineClass, string[]> = {
  excavator: ["336", "320"],
  dozer: ["D8", "D6"],
};

export function componentsFor(machineClass: string): ComponentDef[] {
  return COMPONENTS[(machineClass as MachineClass) in COMPONENTS ? (machineClass as MachineClass) : "excavator"];
}

export function componentKeys(machineClass: string): string[] {
  return componentsFor(machineClass).map((c) => c.key);
}

export function findComponent(machineClass: string, key: string): ComponentDef | undefined {
  return componentsFor(machineClass).find((c) => c.key === key);
}

/** Recurrence window (§9): default max(100 engine hours, 14 days), per-component override. */
export function recurrenceWindow(machineClass: string, component: string): { hours: number; days: number } {
  const def = findComponent(machineClass, component);
  return {
    hours: def?.recurrenceHours ?? 100,
    days: def?.recurrenceDays ?? 14,
  };
}
