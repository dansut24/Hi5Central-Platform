import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { MarketingApp } from './features/marketing/MarketingApp.jsx'
import { SignupPage } from './features/marketing/SignupPage.jsx'
import { ServiceCatalogueSettingsEnhancer } from './features/catalogue/ServiceCatalogueSettingsEnhancer.jsx'
import { KnowledgeContextEnhancer } from './features/knowledge/KnowledgeContextEnhancer.jsx'
import { OrganisationSitesEnhancer } from './features/people/OrganisationSitesEnhancer.jsx'
import { OnboardingMfaEnhancer } from './features/security/OnboardingMfaEnhancer.jsx'
import { ProductionPasswordRecoveryEnhancer } from './features/security/ProductionPasswordRecoveryEnhancer.jsx'
import { ProductionAccessControl } from './production/ProductionAccessControl.jsx'
import { ProductionAccessGuard } from './production/ProductionAccessGuard.jsx'
import { ProductionAssignmentExperience } from './production/ProductionAssignmentExperience.jsx'
import { ProductionFinalTaskCompletionPrompt } from './production/ProductionFinalTaskCompletionPrompt.jsx'
import { ProductionSessionBoundary } from './production/ProductionSessionBoundary.jsx'
import { ProductionFirstLoginRouteBridge } from './production/ProductionFirstLoginRouteBridge.jsx'
import { ProductionItsmWorkspace } from './production/ProductionItsmWorkspace.jsx'
import { ProductionCmdb } from './production/ProductionCmdb.jsx'
import { ProductionLiveChatBadgeBridge } from './production/ProductionLiveChatBadgeBridge.jsx'
import { ProductionLiveChatOperations, ProductionPortalLiveChatOperations } from './production/ProductionLiveChatOperations.jsx'
import { ProductionLiveChatCompactTools } from './production/ProductionLiveChatCompactTools.jsx'
import { ProductionLiveChatWorkspace } from './production/ProductionLiveChatWorkspace.jsx'
import { ProductionNavigationDockPreferences } from './production/ProductionNavigationDockPreferences.jsx'
import { ProductionNotificationCenter } from './production/ProductionNotificationCenter.jsx'
import { ProductionOrganisationWriteThrough } from './production/ProductionOrganisationWriteThrough.jsx'
import { ProductionPortalBootstrap } from './production/ProductionPortalBootstrap.jsx'
import { ProductionPortalKnowledgeChat } from './production/ProductionPortalKnowledgeChat.jsx'
import { ProductionPortalThemeBridge } from './production/ProductionPortalThemeBridge.jsx'
import { ProductionPremiumWorkspaceExperience } from './production/ProductionPremiumWorkspaceExperience.jsx'
import { ProductionRecordDetailRouter } from './production/ProductionRecordDetailRouter.jsx'
import { ProductionRecordWorkspace } from './production/ProductionRecordWorkspace.jsx'
import { ProductionRecordExportEnhancer } from './production/ProductionRecordExportEnhancer.jsx'
import { ProductionRecordListInteractionEnhancer } from './production/ProductionRecordListInteractionEnhancer.jsx'
import { ProductionUniversalPeekV2 } from './production/ProductionUniversalPeekV2.jsx'
import { ProductionWorkflowExperience } from './production/ProductionWorkflowExperience.jsx'
import { ProductionWorkspaceBootstrap } from './production/ProductionWorkspaceBootstrap.jsx'
import { CustomerEnvironmentPending } from './production/CustomerEnvironmentPending.jsx'
import { ManagedSandboxInvitationPage } from './production/ManagedSandboxInvitationPage.jsx'
import { ProductionWorkspaceLiveChatMenu } from './production/ProductionWorkspaceLiveChatMenu.jsx'
import { ProductionWorkspaceRefinement } from './production/ProductionWorkspaceRefinement.jsx'
import { ProductionWorkspaceTabPersistence, installWorkspaceTabSessionIsolation } from './production/ProductionWorkspaceTabPersistence.jsx'
import { resolveTenantSurface, markManagedWorkspaceVerified } from './lib/tenantSurface.js'
import { deploymentConfig } from './lib/deploymentConfig.js'
import './features/settings/ProductionSettingsFloating.css'
import './features/people/OrganisationContextual.css'
import './features/onboarding/OnboardingViewportFix.css'
import './production/ProductionItsmMobileViewFix.css'
import './production/ProductionItsmSurfacePolish.css'
import './production/ProductionWorkspaceFinalPolish.css'
import './PlatformCurves.css'
import './ContextualSurfaces.css'
import './production/ProductionWorkspaceVisualSystem.css'
import './production/ProductionActivityFirstRecord.css'
import './production/ProductionWorkspaceDensity.css'
import './production/ProductionPlanningSurface.css'
import './production/ProductionPlanningResponsive.css'
import './production/ProductionResponsiveViewport.css'
import './production/ProductionLiquidGlassWorkspace.css'
import './production/ProductionShellV3Corrections.css'
import './production/ProductionWorkspaceTabBehaviour.css'
import './production/ProductionSharedRecordMasthead.css'
import './production/ProductionPremiumWorkspaceExperience.css'
import './production/ProductionUniversalPeekV2.css'
import './production/ProductionRecordInspectorClassic.css'
import './production/ProductionRecordExperienceFinal.css'
import './production/ProductionWorkflowGuard.css'
import './production/ProductionItsmUnifiedShell.css'
import './production/ProductionItsmUnifiedPages.css'
import './production/ProductionItsmRecordTheme.css'
import './production/ProductionRmmThemeParity.css'
import './production/RmmSidebarParity.css'
import './production/ProductionDashboardTest2Parity.css'
import './production/ProductionRecordDensity.css'
import './production/ProductionWorkspaceLegibility.css'
import './production/ProductionActivityFocus.css'
import './production/ProductionRecordWorkbench.css'
import './production/ProductionRecordLiquidGlass.css'
import './production/ProductionRecordInlineComposer.css'
import './production/ProductionRichNoteEditor.css'
import './production/ProductionWorkingPeekModal.css'
import './production/ProductionCalendarWorkbench.css'
import './production/ProductionPlanningWorkbenchPolish.css'
import './production/ProductionCalendarTeams.css'
import './production/ProductionProjectWorkbench.css'
import './production/ProductionOrganisationKnowledgeLayout.css'
import './production/ProductionLiquidGlassTabs.css'

installWorkspaceTabSessionIsolation()

const rootElement = document.getElementById('root')
const initialSurface = resolveTenantSurface()
document.documentElement.dataset.hi5Surface = initialSurface.kind
document.body.dataset.hi5Surface = initialSurface.kind
if (rootElement) rootElement.dataset.hi5Surface = initialSurface.kind

function AppComposition({ surface }) {
const productionWorkspace = surface.kind === 'workspace'
const productionPortal = initialSurface.kind === 'portal'
const productionOnboarding = productionWorkspace
  && (window.location.pathname === '/onboarding' || window.location.pathname.startsWith('/onboarding/'))

let RootApp = ProductionWorkspaceBootstrap
if (surface.kind === 'marketing') {
  RootApp = window.location.pathname === '/signup' || window.location.pathname.startsWith('/signup/')
    ? SignupPage
    : MarketingApp
}
if (productionWorkspace) RootApp = ProductionWorkspaceBootstrap
if (productionPortal) RootApp = ProductionPortalBootstrap
if (surface.kind === 'environment-pending') RootApp = CustomerEnvironmentPending
if (surface.kind === 'environment-pending' && window.location.pathname === '/accept-invitation') {
  RootApp = ManagedSandboxInvitationPage
}

return (
  <>
    <RootApp />
    {initialSurface.kind === 'workspace' && !productionOnboarding && !productionWorkspace ? <KnowledgeContextEnhancer /> : null}
    {initialSurface.kind === 'workspace' && !productionOnboarding ? <OrganisationSitesEnhancer /> : null}
    {initialSurface.kind === 'workspace' && !productionOnboarding ? <ServiceCatalogueSettingsEnhancer /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionAccessGuard /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionSessionBoundary /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionAccessControl /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionOrganisationWriteThrough /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionItsmWorkspace /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionAssignmentExperience /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionFinalTaskCompletionPrompt /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionCmdb /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionLiveChatBadgeBridge /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionLiveChatWorkspace /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionLiveChatOperations /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionLiveChatCompactTools /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionRecordDetailRouter /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionRecordWorkspace /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionRecordExportEnhancer /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionRecordListInteractionEnhancer /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionWorkflowExperience /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionNotificationCenter /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionWorkspaceRefinement /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionNavigationDockPreferences /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionWorkspaceTabPersistence /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionWorkspaceLiveChatMenu /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionPremiumWorkspaceExperience /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionPortalThemeBridge /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionUniversalPeekV2 /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionFirstLoginRouteBridge /> : null}
    {productionWorkspace && !productionOnboarding ? <OnboardingMfaEnhancer /> : null}
    {productionWorkspace && !productionOnboarding ? <ProductionPasswordRecoveryEnhancer /> : null}
    {productionPortal ? <ProductionPortalKnowledgeChat /> : null}
    {productionPortal ? <ProductionPortalLiveChatOperations /> : null}
  </>
)
}

function ManagedCustomerEnvironmentGateway({ surface }) {
  const [approved, setApproved] = useState(false)

  useEffect(() => {
    let cancelled = false
    const config = deploymentConfig()
    const apiBase = window.__HI5_API_BASE__ || config.apiUrl
    const expectedHost = `${surface.tenantSlug}${surface.environment}.${config.rootDomain}`
    const validScope = config.deploymentMode === 'managed'
      && config.tenancyMode === 'multi'
      && config.runtimeEnvironment === surface.environment
      && window.location.hostname.toLowerCase() === expectedHost
      && window.location.protocol === 'https:'
    let api
    try { api = new URL(apiBase) } catch { return undefined }
    // Customer workspaces must never fall back to the Live API.
    if (!validScope || api.protocol !== 'https:'
        || api.hostname === `api.${config.rootDomain}`
        || api.origin !== new URL(config.apiUrl).origin) return undefined

    async function verify() {
      try {
        const url = new URL('/api/v1/system/customer-environment/status', api)
        url.searchParams.set('tenantSlug', surface.tenantSlug)
        const response = await fetch(url, { credentials:'omit', cache:'no-store' })
        if (!response.ok || cancelled) return
        const status = await response.json()
        if (cancelled || status.active !== true
            || status.environment !== surface.environment
            || status.tenantSlug !== surface.tenantSlug) return
        markManagedWorkspaceVerified({
          hostname: window.location.hostname, environment: surface.environment,
          tenantSlug: surface.tenantSlug,
        })
        setApproved(true)
      } catch { /* Keep the pending screen on any error. */ }
    }
    verify()
    return () => { cancelled = true }
  }, [surface.environment, surface.tenantSlug])

  if (!approved) return <CustomerEnvironmentPending />
  const activeSurface = resolveTenantSurface(window.location)
  if (activeSurface.kind !== 'workspace') return <CustomerEnvironmentPending />
  document.documentElement.dataset.hi5Surface = 'workspace'
  document.body.dataset.hi5Surface = 'workspace'
  if (rootElement) rootElement.dataset.hi5Surface = 'workspace'
  return <AppComposition surface={activeSurface} />
}

createRoot(rootElement).render(
  <StrictMode>
    {initialSurface.kind === 'environment-pending'
      && window.location.pathname !== '/accept-invitation'
      && !window.location.hostname.toLowerCase().match(/-(?:rmm|portal)\./)
      ? <ManagedCustomerEnvironmentGateway surface={initialSurface} />
      : <AppComposition surface={initialSurface} />}
  </StrictMode>,
)