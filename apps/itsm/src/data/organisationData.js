// Production organisation data is tenant-owned and loaded from PostgreSQL.
// Keep these exports empty so a new or cleared browser can never manufacture
// People, Teams or Departments that do not exist for the authenticated tenant.
export const organisationDepartments = []
export const organisationTeams = []
export const organisationPeople = []

// Availability choices are UI values, not seeded tenant People records.
export const availabilityOptions = ['Available', 'Busy', 'Away', 'Offline']

// These are UI suggestions only; they are not organisation records and are never
// persisted unless an administrator explicitly selects one for a real Person.
export const organisationLocations = []
