import { HomeSidebar } from '@/components/HomeSidebar';
import { HomeHero } from '@/components/HomeHero';

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-background lg:flex lg:h-screen lg:overflow-hidden">
      <HomeSidebar />
      <main className="min-w-0 flex-1 overflow-x-hidden lg:overflow-y-auto">
        <HomeHero />
      </main>
    </div>
  );
}
