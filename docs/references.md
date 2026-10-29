# References

Sources used for each method, with one line on what each was used for.

## Shared finite element core (sheets 01, 02, 03)

- A. Kassimali, *Matrix Analysis of Structures*, 2nd ed., Cengage, 2012. Plane truss and plane frame element stiffness, coordinate transformation, fixed end forces for distributed loads, assembly and support handling.
- W. McGuire, R. H. Gallagher, R. D. Ziemian, *Matrix Structural Analysis*, 2nd ed., Wiley, 2000. Cross check of the frame element and consistent load vectors.
- G. H. Golub, C. F. Van Loan, *Matrix Computations*, 4th ed., Johns Hopkins, 2013. LU with partial pivoting, banded Cholesky, conjugate gradient, cyclic Jacobi eigenvalue method, Cholesky reduction of the generalized eigenproblem.

## Sheet 01 Frame and truss

- Kassimali (above), chapters on plane trusses and plane frames. Element routines and the triangle and Pratt truss checks.
- R. C. Hibbeler, *Structural Analysis*, 10th ed., Pearson, 2017. Method of joints answers for the truss cases.

## Sheet 02 Beam diagrams and Mohr's circle

- R. C. Hibbeler, *Mechanics of Materials*, 10th ed., Pearson, 2017. Beam deflection table (cantilever, simply supported, propped, fixed fixed), shear and moment relations, plane stress transformation and Mohr's circle.
- J. M. Gere, B. J. Goodno, *Mechanics of Materials*, 9th ed., Cengage, 2018. Sign convention for Mohr's circle and absolute maximum shear in plane stress.

## Sheet 03 Topology optimizer

- E. Andreassen, A. Clausen, M. Schevenels, B. S. Lazarov, O. Sigmund, "Efficient topology optimization in MATLAB using 88 lines of code", *Struct Multidisc Optim* 43, 1 to 16 (2011). https://doi.org/10.1007/s00158-010-0594-7 . The code is ported line by line: KE, edofMat, filters, OC update, modified SIMP.
- O. Sigmund, "A 99 line topology optimization code written in Matlab", *Struct Multidisc Optim* 21, 120 to 127 (2001). https://doi.org/10.1007/s001580050176 . MBB beam setup and the sensitivity filter.
- O. Sigmund, "Morphology-based black and white filters for topology optimization", *Struct Multidisc Optim* 33, 401 to 424 (2007). https://doi.org/10.1007/s00158-006-0087-x . Measure of non-discreteness, M_nd = sum(4 x (1 - x)) / n.
- TopOpt group, DTU, top88.m source listing. https://www.topopt.mek.dtu.dk/apps-and-software . Reference for exact constants and loop structure.

## Sheet 04 Wind tunnel

- T. Krüger, H. Kusumaatmaja, A. Kuzmin, O. Shardt, G. Silva, E. M. Viggen, *The Lattice Boltzmann Method: Principles and Practice*, Springer, 2017. https://doi.org/10.1007/978-3-319-44649-3 . D2Q9 lattice, BGK and TRT collision (magic parameter 1/4), viscosity and relaxation time relation, halfway bounce-back, momentum exchange forces, stability limits.
- Q. Zou, X. He, "On pressure and velocity boundary conditions for the lattice Boltzmann BGK model", *Phys. Fluids* 9, 1591 (1997). https://doi.org/10.1063/1.869307 . Velocity inlet.
- M. Bouzidi, M. Firdaouss, P. Lallemand, "Momentum transfer of a Boltzmann-lattice fluid with boundaries", *Phys. Fluids* 13, 3452 (2001). https://doi.org/10.1063/1.1399290 . Linear interpolated bounce back on curved walls.
- Z. Guo, C. Zheng, B. Shi, "Non-equilibrium extrapolation method for velocity and pressure boundary conditions in the lattice Boltzmann method", *Chinese Physics* 11, 366 (2002). https://doi.org/10.1088/1009-1963/11/4/310 . Fixed density outflow.
- R. Mei, D. Yu, W. Shyy, L.-S. Luo, "Force evaluation in the lattice Boltzmann method involving curved geometry", *Phys. Rev. E* 65, 041203 (2002). https://doi.org/10.1103/PhysRevE.65.041203 . Momentum exchange with interpolated walls.
- A. J. C. Ladd, "Numerical simulations of particulate suspensions via a discretized Boltzmann equation", *J. Fluid Mech.* 271, 285 to 309 (1994). Momentum exchange force on solid obstacles.
- M. Schäfer, S. Turek, "Benchmark computations of laminar flow around a cylinder", in *Flow Simulation with High-Performance Computers II*, Notes on Numerical Fluid Mechanics 52, Vieweg, 1996, 547 to 566. Reference values for case 2D-1 (Re = 20). Featflow benchmark page: http://www.featflow.de/en/benchmarks/cfdbenchmarking/flow/dfg_benchmark1_re20.html
- C. H. K. Williamson, "Vortex dynamics in the cylinder wake", *Annu. Rev. Fluid Mech.* 28, 477 to 539 (1996). https://doi.org/10.1146/annurev.fl.28.010196.002401 . Strouhal number versus Reynolds number for a circular cylinder (St about 0.164 at Re = 100).
- I. H. Abbott, A. E. von Doenhoff, *Theory of Wing Sections*, Dover, 1959, section 6.4. NACA 4 digit thickness and camber line equations.
- E. N. Jacobs, K. E. Ward, R. M. Pinkerton, "The characteristics of 78 related airfoil sections from tests in the variable-density wind tunnel", NACA Report 460 (1933). Original NACA 4 digit definition.

## Sheet 05 Laminate

- R. M. Jones, *Mechanics of Composite Materials*, 2nd ed., Taylor and Francis, 1999. Reduced stiffness Q, transformed Q bar, A, B and D matrices, ply strains and stresses.
- A. K. Kaw, *Mechanics of Composite Materials*, 2nd ed., CRC Press, 2006, Table 2.1. T300/5208 graphite epoxy properties (E1 181, E2 10.3, G12 7.17 GPa, nu12 0.28, strengths 1500, 1500, 40, 246, 68 MPa).
- I. M. Daniel, O. Ishai, *Engineering Mechanics of Composite Materials*, 2nd ed., Oxford, 2006, Appendix A. Typical properties for AS4/3501-6, E-glass epoxy and Kevlar 49 epoxy.
- S. W. Tsai, E. M. Wu, "A general theory of strength for anisotropic materials", *J. Composite Materials* 5, 58 to 80 (1971). Tsai Wu criterion and the normalized interaction term F12* = -0.5.
- S. W. Tsai, H. T. Hahn, *Introduction to Composite Materials*, Technomic, 1980. Origin of the T300/5208 data set.

## Sheet 06 Vibrations

- S. S. Rao, *Mechanical Vibrations*, 6th ed., Pearson, 2017. Multi degree of freedom chains, generalized eigenproblem, mass normalized modes, Rayleigh damping, harmonic response.
- D. J. Inman, *Engineering Vibration*, 4th ed., Pearson, 2014. Closed form natural frequencies of an equal mass and spring chain, dynamic amplification of a single degree of freedom system, tuned mass damper.
- Web Audio API, W3C Recommendation. https://www.w3.org/TR/webaudio/ . Oscillator and gain envelope for the tones.

## Sheet 07 Linkage

- R. L. Norton, *Design of Machinery*, 6th ed., McGraw Hill, 2019, chapters 2 and 4. Grashof condition, linkage classes, transmission angle, toggle positions, four bar position analysis with open and crossed branches.
- T. Jansen, *The Great Pretender*, 010 Publishers, 2007, and https://www.strandbeest.com . The 13 "holy numbers" a to m.
- Wikibooks, "Comparison of crank based leg mechanism / draw the Jansen linkage". https://en.wikibooks.org/wiki/Comparison_of_crank_based_leg_mechanism/draw_the_Jansen_linkage . Step by step joint construction by two circle intersections, used to set the joint order and labels.
- Wikipedia, "Jansen's linkage". https://en.wikipedia.org/wiki/Jansen%27s_linkage . Labeled diagram of the leg with lengths a to m and the two rigid triangles (b, d, e) and (g, h, i).
- Wikipedia, "Chebyshev linkage". https://en.wikipedia.org/wiki/Chebyshev_linkage . Link ratios 2 : 2.5 : 1 : 2.5 for the straight line preset.

## Fonts

- Routed Gothic by Darren Embry, SIL Open Font License 1.1. https://github.com/dse/routed-gothic . Taken from the Debian/Ubuntu package fonts-routed-gothic and converted to woff2.
- B612 by the B612 Project (Airbus, Intactile Design), SIL Open Font License 1.1. https://github.com/polarsys/b612 . Taken from the Ubuntu package fonts-b612 and converted to woff2.
