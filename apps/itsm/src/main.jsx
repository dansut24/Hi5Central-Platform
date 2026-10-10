import { StrictMode, useState } from 'react'
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
import { ProductionLiveChatBadgeBridge, ProductionFloatingTechnicianChat } from './production/ProductionLiveChatBadgeBridge.jsx'
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
import { EnvironmentBanner } from './production/EnvironmentBanner.jsx'
import { ProductionWorkspaceLiveChatMenu } from './production/ProductionWorkspaceLiveChatMenu.jsx'
import { ProductionWorkspaceRefinement } from './production/ProductionWorkspaceRefinement.jsx'
import { ProductionWorkspaceTabPersistence, installWorkspaceTabSessionIsolation } from './production/ProductionWorkspaceTabPersistence.jsx'
import { resolveTenantSurface } from './lib/tenantSurface.js'
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

const productionWorkspace = initialSurface.kind === 'workspace'
const productionPortal = initialSurface.kind === 'portal'
const productionOnboarding = productionWorkspace
  && (window.location.pathname === '/onboarding' || window.location.pathname.startsWith('/onboarding/'))

let RootApp = ProductionWorkspaceBootstrap
if (initialSurface.kind === 'marketing') {
  RootApp = window.location.pathname === '/signup' || window.location.pathname.startsWith('/signup/')
    ? SignupPage
    : MarketingApp
}
if (productionWorkspace) RootApp = ProductionWorkspaceBootstrap
if (productionPortal) RootApp = ProductionPortalBootstrap

function AppWithWorkspaceBoundaries() {
  // Only the authentication bootstrap and environment banner are allowed to
  // mount before a valid server session. Previously every workspace observer
  // ran on /login and could stall Safari before the login form appeared.
  const [workspaceAuthenticated,setWorkspaceAuthenticated]=useState(false)
  const productionWorkspaceReady=productionWorkspace && workspaceAuthenticated && !productionOnboarding
  return (
    <>
    <EnvironmentBanner />
    <RootApp onWorkspaceAuthenticatedChange={setWorkspaceAuthenticated} />
    {initialSurface.kind === 'workspace' && !productionOnboarding && !productionWorkspace ? <KnowledgeContextEnhancer /> : null}
    {productionWorkspaceReady ? <OrganisationSitesEnhancer /> : null}
    {productionWorkspaceReady ? <ServiceCatalogueSettingsEnhancer /> : null}
    {productionWorkspaceReady ? <ProductionAccessGuard /> : null}
    {productionWorkspaceReady ? <ProductionSessionBoundary /> : null}
    {productionWorkspaceReady ? <ProductionAccessControl /> : null}
    {productionWorkspaceReady ? <ProductionOrganisationWriteThrough /> : null}
    {productionWorkspaceReady ? <ProductionItsmWorkspace /> : null}
    {productionWorkspaceReady ? <ProductionAssignmentExperience /> : null}
    {productionWorkspaceReady ? <ProductionFinalTaskCompletionPrompt /> : null}
    {productionWorkspaceReady ? <ProductionCmdb /> : null}
    {productionWorkspaceReady ? <ProductionLiveChatBadgeBridge /> : null}
    {productionWorkspaceReady ? <ProductionFloatingTechnicianChat /> : null}
    {productionWorkspaceReady ? <ProductionLiveChatWorkspace /> : null}
    {productionWorkspaceReady ? <ProductionLiveChatOperations /> : null}
    {productionWorkspaceReady ? <ProductionLiveChatCompactTools /> : null}
    {productionWorkspaceReady ? <ProductionRecordDetailRouter /> : null}
    {productionWorkspaceReady ? <ProductionRecordWorkspace /> : null}
    {productionWorkspaceReady ? <ProductionRecordExportEnhancer /> : null}
    {productionWorkspaceReady ? <ProductionRecordListInteractionEnhancer /> : null}
    {productionWorkspaceReady ? <ProductionWorkflowExperience /> : null}
    {productionWorkspaceReady ? <ProductionNotificationCenter /> : null}
    {productionWorkspaceReady ? <ProductionWorkspaceRefinement /> : null}
    {productionWorkspaceReady ? <ProductionNavigationDockPreferences /> : null}
    {productionWorkspaceReady ? <ProductionWorkspaceTabPersistence /> : null}
    {productionWorkspaceReady ? <ProductionWorkspaceLiveChatMenu /> : null}
    {productionWorkspaceReady ? <ProductionPremiumWorkspaceExperience /> : null}
    {productionWorkspaceReady ? <ProductionPortalThemeBridge /> : null}
    {productionWorkspaceReady ? <ProductionUniversalPeekV2 /> : null}
    {productionWorkspaceReady ? <ProductionFirstLoginRouteBridge /> : null}
    {productionWorkspaceReady ? <OnboardingMfaEnhancer /> : null}
    {productionWorkspaceReady ? <ProductionPasswordRecoveryEnhancer /> : null}
    {productionPortal ? <ProductionPortalKnowledgeChat /> : null}
    {productionPortal ? <ProductionPortalLiveChatOperations /> : null}
    </>
  )
}

createRoot(rootElement).render(<StrictMode><AppWithWorkspaceBoundaries /></StrictMode>)