import { AuthDialogProvider } from "@/features/landing/components/auth-cta";
import { CoupleSection } from "@/features/landing/components/couple-section";
import { FeaturesSection } from "@/features/landing/components/features-section";
import { FinalCta, LandingFooter } from "@/features/landing/components/final-cta";
import { GamesSection } from "@/features/landing/components/games-section";
import { Hero } from "@/features/landing/components/hero";
import { LandingNav } from "@/features/landing/components/landing-nav";
import { PrivacySection } from "@/features/landing/components/privacy-section";
import { ProductPreview } from "@/features/landing/components/product-preview";

/**
 * The landing page is composition only — every section owns its own markup,
 * motion and copy, and the route just puts them in order. Same rule as the rest
 * of the app: `app/` arranges, `features/` decides.
 */
export default function LandingPage() {
  return (
    <AuthDialogProvider>
      <LandingNav />

      <main>
        <Hero />
        <ProductPreview />
        <FeaturesSection />
        <GamesSection />
        <CoupleSection />
        <PrivacySection />
        <FinalCta />
      </main>

      <LandingFooter />
    </AuthDialogProvider>
  );
}
